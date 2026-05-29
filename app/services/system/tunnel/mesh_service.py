"""Mesh tunnel orchestration and status ownership."""

import logging
import os

import gevent

import app.services.system.network_detection_service as network_detection_service
from app.constants import SOCKET_EVENTS
from app.services.system.tunnel.mesh_watchdog_service import (
    attempt_mesh_recovery,
    start_mesh_watchdog,
    stop_mesh_watchdog,
)
from app.services.system.headscale.access_service import (
    delete_node,
    generate_client_preauth_key,
    generate_preauth_key,
    generate_tailscale_qr_code,
    get_all_nodes,
    get_nodes,
)
from app.services.system.headscale.cli_service import INSTANCE_DIR
from app.services.system.headscale.config_service import (
    ensure_derp_enabled,
    ensure_bootstrap_server_url,
    get_bootstrap_server_url,
    get_config_server_url,
    is_invalid_bootstrap_server_url,
    normalize_server_url,
    repair_server_url_from_bootstrap,
    ensure_server_url,
    generate_config,
)
from app.services.system.headscale.connectivity_service import (
    is_hs_running,
    manual_dns_update,
    verify_tailscale_connectivity,
)
from app.services.system.headscale.runtime_service import start_hs, stop_hs
from specter import registry
from app.services.system.tunnel.state_service import (
    get_active_tunnel_info,
    replace_active_tunnel_info,
    set_active_tunnel_info,
    update_tunnel_runtime,
)
from app.utils.system_utils import get_local_ip

logger = logging.getLogger(__name__)

# Track the background startup greenlet so we can avoid double-starts.
_startup_greenlet = None


def _is_invalid_enrollment_server_url(server_url):
    """Reject mesh/app-loopback URLs for local custom-server enrollment."""
    return is_invalid_bootstrap_server_url(server_url)


def _get_server_url():
    """Build the local Headscale coordination URL without using the public IP."""
    interface_ips = network_detection_service.get_interface_ips()
    local_ip = interface_ips.get('eth0') or interface_ips.get('wlan0') or get_local_ip()
    return f"http://{local_ip}:8080"


def _get_bootstrap_server_url():
    """Pick a stable local enrollment URL for Headscale custom-server login."""
    interface_ips = network_detection_service.get_interface_ips()
    active_ips = set(interface_ips.values())

    bootstrap_url = normalize_server_url(get_bootstrap_server_url())
    if bootstrap_url and not _is_invalid_enrollment_server_url(bootstrap_url):
        from urllib.parse import urlsplit
        parts = urlsplit(bootstrap_url)
        if parts.hostname in active_ips:
            return bootstrap_url

    existing_url = normalize_server_url(get_config_server_url())
    if existing_url and not _is_invalid_enrollment_server_url(existing_url):
        from urllib.parse import urlsplit
        parts = urlsplit(existing_url)
        if parts.hostname in active_ips:
            return existing_url

    return _get_server_url()



def _requires_local_server_url_repair(server_url):
    """Repair stale interface IPs, poisoned app/loopback URLs, or invalid URLs."""
    if is_invalid_bootstrap_server_url(server_url):
        return True

    from urllib.parse import urlsplit
    parts = urlsplit(server_url)
    if not parts.hostname:
        return True

    # If the hostname is an IP, check if it's currently active on our interfaces
    import ipaddress
    try:
        ipaddress.ip_address(parts.hostname)
        active_ips = set(network_detection_service.get_interface_ips().values())
        if parts.hostname not in active_ips:
            return True
    except ValueError:
        # Not an IP address (e.g. domain), assume OK
        pass

    return False



def _emit_tunnel_status(data):
    """Push a tunnel status update to all connected clients via socket."""
    try:
        transport = registry.require('socket_transport')
        transport.emit(SOCKET_EVENTS['TUNNEL_STATUS_UPDATE'], data)
    except Exception as exc:
        logger.debug("Could not emit tunnel status: %s", exc)


def _set_mesh_runtime_state(**partial):
    """Persist mesh runtime state so polling stays aligned with socket updates."""
    set_active_tunnel_info(partial)


def remove_mesh_node(node_id: int):
    """Remove a node from the mesh."""
    success, message = delete_node(node_id)
    return {"status": "success" if success else "error", "message": message}


def _mesh_progress(stage, message):
    """Progress callback passed into sub-services so they can report granular status."""
    _set_mesh_runtime_state(status="starting", stage=stage, message=message)
    _emit_tunnel_status({
        "status": "starting",
        "provider": "mesh",
        "stage": stage,
        "message": message,
    })


def _run_mesh_startup(bootstrap_server_url, app_url):
    """Heavy startup work — runs in a background greenlet so the HTTP request returns fast."""
    global _startup_greenlet
    try:
        # --- Stage: config ---
        _mesh_progress("config", "Generating configuration...")

        config_path = os.path.join(INSTANCE_DIR, "config.yaml")
        if not os.path.exists(config_path):
            if not generate_config(bootstrap_server_url):
                _set_mesh_runtime_state(status="error", message="Failed to generate config")
                _emit_tunnel_status({"status": "error", "provider": "mesh", "message": "Failed to generate config"})
                return
        elif not ensure_bootstrap_server_url(bootstrap_server_url):
            _set_mesh_runtime_state(status="error", message="Failed to sync config")
            _emit_tunnel_status({"status": "error", "provider": "mesh", "message": "Failed to sync config"})
            return
        else:
            current_server_url = get_config_server_url()
            if current_server_url and not _requires_local_server_url_repair(current_server_url):
                pass
            elif not repair_server_url_from_bootstrap() and not ensure_server_url(bootstrap_server_url):
                _set_mesh_runtime_state(status="error", message="Failed to sync config")
                _emit_tunnel_status({"status": "error", "provider": "mesh", "message": "Failed to sync config"})
                return
        if not ensure_derp_enabled():
            _set_mesh_runtime_state(status="error", message="Failed to normalize DERP config")
            _emit_tunnel_status({"status": "error", "provider": "mesh", "message": "Failed to normalize DERP config"})
            return

        # --- Stage: headscale (server process only) ---
        _mesh_progress("headscale", "Starting Headscale server...")

        hs_success, hs_message = start_hs(progress_cb=_mesh_progress)
        if not hs_success:
            _set_mesh_runtime_state(status="error", stage="headscale", message=hs_message)
            _emit_tunnel_status({"status": "error", "provider": "mesh", "message": hs_message})
            return

        # --- Stage: dns ---
        _mesh_progress("dns", "Configuring mesh DNS...")

        try:
            dns_success = manual_dns_update()
            if dns_success:
                logger.info("DNS configured - ghosthub.mesh.local will work on both AP and mesh")
            else:
                logger.warning("DNS update failed - ghosthub.mesh.local may not work on mesh")
        except Exception as err:
            logger.error("DNS verification failed: %s", err)

        # --- Stage: keys ---
        _mesh_progress("keys", "Generating authentication keys...")

        username, preauth_key = generate_client_preauth_key({
            'device_type': 'client',
            'platform': 'remote',
        })
        if not preauth_key:
            preauth_key = generate_preauth_key(user="local")
            username = "local"

        control_url = bootstrap_server_url
        _set_mesh_runtime_state(
            control_url=control_url,
            preauth_key=preauth_key,
        )
        start_mesh_watchdog()

        qr_code = generate_tailscale_qr_code(control_url, preauth_key)
        _set_mesh_runtime_state(qr_code=qr_code)

        # --- Done ---
        _set_mesh_runtime_state(
            status="running",
            stage=None,
            message=None,
            control_url=control_url,
        )
        _emit_tunnel_status({
            "status": "running",
            "provider": "mesh",
            "url": bootstrap_server_url,
            "control_url": control_url,
            "app_url": app_url,
            "preauth_key": preauth_key,
        })
        logger.info("Secure Mesh startup complete")
    except Exception as exc:
        logger.error("Mesh startup greenlet failed: %s", exc)
        _set_mesh_runtime_state(status="error", message=str(exc))
        _emit_tunnel_status({"status": "error", "provider": "mesh", "message": str(exc)})
    finally:
        _startup_greenlet = None


def start_mesh_tunnel():
    """Start Secure Mesh using Headscale for coordination and Tailscale connectivity.

    Returns immediately with ``status: starting`` and runs the heavy work in a
    background greenlet so the frontend receives real-time socket progress.
    """
    global _startup_greenlet

    active_info = get_active_tunnel_info()
    if active_info["provider"] and active_info["provider"] != "mesh":
        return {
            "status": "error",
            "message": f"Another tunnel ({active_info['provider']}) is already running.",
        }

    # Prevent double-starts while a startup is still in progress.
    if _startup_greenlet is not None and not _startup_greenlet.dead:
        return {
            "status": "starting",
            "message": "Mesh startup already in progress.",
        }

    bootstrap_server_url = _get_bootstrap_server_url()
    app_url = "http://ghosthub.mesh.local:5000"

    # Persist initial "starting" state so immediate /status polls see it.
    _set_mesh_runtime_state(
        provider="mesh",
        status="starting",
        stage="config",
        message="Generating configuration...",
        url=bootstrap_server_url,
        app_url=app_url,
    )
    _emit_tunnel_status({"status": "starting", "provider": "mesh", "stage": "config"})

    # Spawn heavy work in background — HTTP response returns instantly.
    _startup_greenlet = gevent.spawn(_run_mesh_startup, bootstrap_server_url, app_url)

    return {
        "status": "starting",
        "message": "Secure Mesh startup initiated. Watch for progress updates.",
    }


def stop_mesh_tunnel():
    """Stop the active Secure Mesh runtime."""
    global _startup_greenlet
    if _startup_greenlet is not None and not _startup_greenlet.dead:
        _startup_greenlet.kill()
        _startup_greenlet = None
    stop_mesh_watchdog()
    stop_hs()
    replace_active_tunnel_info()
    _emit_tunnel_status({"status": "stopped", "provider": "mesh"})
    return {"status": "success", "message": "Secure Mesh stopped."}


def get_mesh_tunnel_status():
    """Get status for the active mesh tunnel."""
    active_info = get_active_tunnel_info()
    hs_active = is_hs_running()
    cached_status = active_info.get("status")
    cached_stage = active_info.get("stage")
    cached_message = active_info.get("message")
    cached_app_url = active_info.get("app_url") or "http://ghosthub.mesh.local:5000"

    if cached_status == "starting":
        return {
            "status": "starting",
            "provider": "mesh",
            "url": active_info.get("url"),
            "control_url": active_info.get("control_url"),
            "app_url": cached_app_url,
            "stage": cached_stage,
            "message": cached_message,
            "hs_active": hs_active,
            "mesh_health": "starting",
        }

    if cached_status == "error":
        return {
            "status": "error",
            "provider": "mesh",
            "url": active_info.get("url"),
            "control_url": active_info.get("control_url"),
            "app_url": cached_app_url,
            "stage": cached_stage,
            "message": cached_message or "Mesh startup failed.",
            "hs_active": hs_active,
            "mesh_health": "error",
        }

    if not hs_active:
        attempt_mesh_recovery("Headscale service not active")
        return {
            "status": "starting",
            "provider": "mesh",
            "url": active_info.get("url"),
            "control_url": active_info.get("control_url"),
            "app_url": cached_app_url,
            "stage": "headscale",
            "message": "Mesh recovering...",
            "hs_active": False,
            "mesh_health": "recovering",
        }

    connectivity_ok = verify_tailscale_connectivity()
    if not connectivity_ok:
        failures = update_tunnel_runtime(
            lambda draft: draft.__setitem__(
                'mesh_connectivity_failures',
                draft.get('mesh_connectivity_failures', 0) + 1,
            ),
        ).get('mesh_connectivity_failures', 0)
        if failures >= 3:
            attempt_mesh_recovery(
                f"Headscale active but Pi Tailscale connectivity check failed {failures} times",
            )
    else:
        update_tunnel_runtime(
            lambda draft: draft.__setitem__('mesh_connectivity_failures', 0),
        )

    active_info = get_active_tunnel_info()
    server_url = active_info.get("url")
    control_url = active_info.get("control_url") or server_url
    if _is_invalid_enrollment_server_url(control_url):
        control_url = _get_bootstrap_server_url()
    preauth_key = active_info.get("preauth_key")
    app_url = active_info.get("app_url") or cached_app_url

    return {
        "status": "running",
        "provider": "mesh",
        "url": server_url,
        "control_url": control_url,
        "app_url": app_url,
        "stage": None,
        "message": None,
        "preauth_key": preauth_key,
        "nodes": get_nodes(),
        "all_nodes": get_all_nodes(),
        "qr_code": (
            generate_tailscale_qr_code(control_url, preauth_key)
            if preauth_key else None
        ),
        "join_command": (
            f"tailscale up --login-server {control_url} --authkey {preauth_key}"
            if preauth_key else None
        ),
        "hs_active": hs_active,
        "mesh_health": "ok" if connectivity_ok else "recovering",
    }
