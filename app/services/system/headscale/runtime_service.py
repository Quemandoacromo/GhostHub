"""Headscale runtime/bootstrap and Tailscale connectivity ownership."""

import logging
import os
from app.services.system.headscale.cli_service import (
    APP_ROOT,
    HS_CONFIG,
    HS_DB,
    INSTANCE_DIR,
    get_headscale_binary,
)
from app.services.system.headscale.bootstrap_service import (
    ensure_instance_writable,
    reset_database_if_needed,
)
from app.services.system.headscale.config_service import (
    ensure_paths,
    repair_server_url_from_bootstrap,
    ensure_systemd_service,
    generate_config,
)
from app.services.system.headscale.connectivity_service import (
    is_hs_running,
    join_pi_to_mesh,
    update_dns_record,
    verify_tailscale_connectivity,
)
from app.services.system.headscale.network_service import configure_tailscale_firewall
from app.services.system.headscale.process_service import (
    ensure_default_users,
    repair_instance_permissions,
    restart_service,
    stop_running_service,
    stop_service,
    wait_for_running,
)
from app.utils.system_utils import get_local_ip
from specter import Service, registry

logger = logging.getLogger(__name__)


class HeadscaleRuntimeService(Service):
    """Own Headscale startup, shutdown, and mesh-join coordination."""

    def __init__(self):
        super().__init__('headscale_runtime', {
            'running': False,
            'last_start_success': None,
            'last_message': None,
            'mesh_joined': False,
        })

    def start_runtime(self, progress_cb=None):
        """Start the Headscale server process using systemd.

        Args:
            progress_cb: Optional ``(stage, message)`` callable used to push
                granular status updates back to the caller (e.g. mesh_service).
        """
        def _progress(stage, message):
            if progress_cb:
                progress_cb(stage, message)

        ensure_paths()
        try:
            hs_binary = get_headscale_binary()
            if not hs_binary or not os.path.exists(hs_binary):
                # Check if headscale exists in install location but wasn't found
                install_path = "/home/ghost/ghosthub/headscale"
                if os.path.exists(install_path):
                    hs_binary = install_path
                else:
                    message = "Headscale binary not found. Run install_ghosthub.sh to download it."
                    self._set_runtime_state(False, message, mesh_joined=False)
                    return False, message

            if not os.path.exists(HS_CONFIG):
                logger.info("Config not found, generating default config for plug-and-play setup")
                server_url = f"http://{get_local_ip()}:8080"
                if not generate_config(server_url):
                    message = "Failed to generate Headscale configuration"
                    self._set_runtime_state(False, message, mesh_joined=False)
                    return False, message
            elif not repair_server_url_from_bootstrap():
                message = "Failed to repair Headscale control URL"
                self._set_runtime_state(False, message, mesh_joined=False)
                return False, message

            if is_hs_running():
                from app.services.system.headscale.config_service import (
                    get_config_server_url,
                    get_bootstrap_server_url,
                    is_invalid_bootstrap_server_url,
                )
                current_config_url = get_config_server_url()
                bootstrap_url = get_bootstrap_server_url()
                if current_config_url != bootstrap_url or is_invalid_bootstrap_server_url(current_config_url):
                    logger.warning("Headscale running with stale IP config - forcing service restart to reload configuration")
                    stop_running_service()
                else:
                    logger.info("Headscale is already running with up-to-date config")
                    if verify_tailscale_connectivity():
                        logger.info("Pi is already connected to mesh with valid IP")
                        update_dns_record()
                        message = "Headscale already running and Pi is connected to mesh."
                        self._set_runtime_state(True, message, mesh_joined=True)
                        return True, message
                    logger.info("Headscale running but Pi not properly connected - attempting to join")

                _progress("joining", "Joining Pi to mesh network...")
                mesh_success = join_pi_to_mesh(progress_cb=progress_cb)
                if not mesh_success:
                    logger.warning(
                        "Pi failed to join mesh network - ghosthub.mesh.local may not work remotely",
                    )
                else:
                    logger.info(
                        "Pi successfully joined mesh network - ghosthub.mesh.local will work remotely",
                    )
                message = "Headscale already running."
                self._set_runtime_state(True, message, mesh_joined=mesh_success)
                return True, message

            _progress("headscale", "Preparing Headscale service...")
            logger.info("Ensuring systemd service is up to date")
            stop_running_service()

            if not reset_database_if_needed():
                logger.warning("Database reset encountered an error; continuing with existing state")

            if not ensure_instance_writable():
                repair_instance_permissions()

            if not ensure_systemd_service():
                message = "Failed to setup Headscale systemd service."
                self._set_runtime_state(False, message, mesh_joined=False)
                return False, message

            logger.info(
                "Headscale paths - Binary: %s, Config: %s, DB: %s, Instance: %s",
                hs_binary,
                HS_CONFIG,
                HS_DB,
                INSTANCE_DIR,
            )

            _progress("headscale", "Restarting Headscale process...")
            logger.info("Restarting Headscale to apply new configuration...")
            restart_service()

            configure_tailscale_firewall()

            _progress("headscale", "Waiting for Headscale to become ready...")
            started, log_snippet = wait_for_running(max_wait=30)
            if not started:
                message = f"Headscale failed to start within 30s. Logs: {log_snippet or ''}"
                self._set_runtime_state(False, message, mesh_joined=False)
                return False, message

            _progress("headscale", "Creating default users...")
            ensure_default_users(hs_binary)

            _progress("joining", "Joining Pi to mesh network...")
            logger.info("Attempting to join Pi to mesh network...")
            mesh_success = join_pi_to_mesh(progress_cb=progress_cb)
            if not mesh_success:
                logger.warning(
                    "Pi failed to join mesh network - ghosthub.mesh.local may not work remotely",
                )
            else:
                logger.info(
                    "Pi successfully joined mesh network - ghosthub.mesh.local will work remotely",
                )
            message = "Headscale started successfully via systemd."
            self._set_runtime_state(True, message, mesh_joined=mesh_success)
            return True, message
        except Exception as err:
            logger.error("Error starting Headscale: %s", err)
            self._set_runtime_state(False, str(err), mesh_joined=False)
            return False, str(err)

    def stop_runtime(self):
        """Stop the Headscale server process using systemd."""
        success, message = stop_service()
        self._set_runtime_state(False, message, mesh_joined=False)
        return success, message

    def on_stop(self):
        """Reset runtime state on Specter shutdown."""
        self._set_runtime_state(False, self.state.get('last_message'), mesh_joined=False)

    def _set_runtime_state(self, running, message, *, mesh_joined):
        self.set_state({
            'running': bool(running),
            'last_start_success': bool(running) if running is not None else None,
            'last_message': message,
            'mesh_joined': bool(mesh_joined),
        })


def start_hs(progress_cb=None):
    """Start the Headscale server process through the registered runtime owner."""
    return registry.require('headscale_runtime').start_runtime(progress_cb=progress_cb)


def stop_hs():
    """Stop the Headscale server process through the registered runtime owner."""
    return registry.require('headscale_runtime').stop_runtime()
