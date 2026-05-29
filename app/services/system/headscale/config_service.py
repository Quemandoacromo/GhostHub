"""Headscale config, path, and systemd ownership."""

import ipaddress
import logging
import os
import subprocess
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

from app.services.system.headscale.cli_service import (
    APP_ROOT,
    HS_CONFIG,
    HS_DB,
    HS_DB_DIR,
    HS_SERVICE_NAME,
    HS_SOCKET,
    INSTANCE_DIR,
    get_headscale_binary,
    yaml,
)

logger = logging.getLogger(__name__)
HS_BOOTSTRAP_URL_PATH = os.path.join(INSTANCE_DIR, "bootstrap_url.txt")
DEFAULT_DERP_MAP_URL = "https://controlplane.tailscale.com/derpmap/default"
INVALID_BOOTSTRAP_HOSTS = {
    "localhost",
    "127.0.0.1",
    "ghosthub.mesh.local",
    "ghosthub",
    "ghosthub.local",
}


def normalize_server_url(raw_url: str) -> Optional[str]:
    """Normalize a Headscale URL onto a plain host:8080 HTTP endpoint."""
    if not raw_url:
        return None

    try:
        parts = urlsplit(str(raw_url).strip())
        hostname = parts.hostname
        if not hostname:
            return None

        scheme = parts.scheme or "http"
        return urlunsplit((scheme, f"{hostname}:8080", "", "", ""))
    except Exception:
        logger.debug("Could not normalize Headscale URL from %s", raw_url)
        return None


def is_invalid_bootstrap_server_url(server_url: str) -> bool:
    """Return True when a URL cannot be used for local custom-server enrollment."""
    normalized = normalize_server_url(server_url)
    if not normalized:
        return True

    try:
        hostname = urlsplit(normalized).hostname
        if not hostname:
            return True

        if hostname in INVALID_BOOTSTRAP_HOSTS:
            return True

        try:
            host_ip = ipaddress.ip_address(hostname)
        except ValueError:
            return False

        return host_ip in ipaddress.ip_network("100.64.0.0/10")
    except Exception:
        return True

def ensure_systemd_service():
    """Create and enable the Headscale systemd service."""
    os.makedirs(INSTANCE_DIR, exist_ok=True)

    hs_binary = get_headscale_binary()
    if not hs_binary or not os.path.exists(hs_binary):
        logger.error("Headscale binary not found, cannot create systemd service.")
        return False
    service_content = f"""[Unit]
Description=Headscale coordination server for GhostHub
After=network.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
ExecStart={hs_binary} serve --config {HS_CONFIG}
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5
User=ghost
Group=ghost
WorkingDirectory={APP_ROOT}
StandardOutput=journal
StandardError=journal
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
"""
    temp_service_path = "/tmp/ghosthub-headscale.service"
    try:
        with open(temp_service_path, "w") as service_file:
            service_file.write(service_content)
        subprocess.run(
            ["sudo", "cp", temp_service_path, f"/etc/systemd/system/{HS_SERVICE_NAME}.service"],
            check=True,
        )
        subprocess.run(["sudo", "systemctl", "daemon-reload"], check=True)
        subprocess.run(["sudo", "systemctl", "enable", HS_SERVICE_NAME], check=True)
        try:
            os.remove(temp_service_path)
        except OSError:
            pass
        return True
    except Exception as err:
        logger.error("Failed to setup headscale systemd service: %s", err)
        return False


def ensure_paths():
    """Ensure Headscale directories exist with proper permissions."""
    if not os.path.exists(INSTANCE_DIR):
        os.makedirs(INSTANCE_DIR, exist_ok=True)
        try:
            subprocess.run(["sudo", "chown", "-R", "ghost:ghost", INSTANCE_DIR], check=False)
            subprocess.run(["sudo", "chmod", "755", INSTANCE_DIR], check=False)
        except Exception as err:
            logger.warning("Could not set ownership on %s: %s", INSTANCE_DIR, err)

    if not os.path.exists(HS_DB_DIR):
        try:
            subprocess.run(["sudo", "mkdir", "-p", HS_DB_DIR], check=True)
            subprocess.run(["sudo", "chown", "-R", "ghost:ghost", HS_DB_DIR], check=True)
            subprocess.run(["sudo", "chmod", "755", HS_DB_DIR], check=True)
        except Exception as err:
            logger.error("Failed to create database directory: %s", err)

    socket_dir = os.path.dirname(HS_SOCKET)
    if not os.path.exists(socket_dir):
        try:
            subprocess.run(["sudo", "mkdir", "-p", socket_dir], check=True)
            subprocess.run(["sudo", "chown", "ghost:ghost", socket_dir], check=True)
            subprocess.run(["sudo", "chmod", "755", socket_dir], check=True)
        except Exception as err:
            logger.error("Failed to create headscale socket directory: %s", err)


def generate_config(server_url: str):
    """Generate a Headscale config file for the local mesh server."""
    if yaml is None:
        logger.error("PyYAML module not available. Cannot generate Headscale config.")
        return False

    server_url = normalize_server_url(server_url)
    if not server_url:
        logger.error("Cannot generate Headscale config without a valid server URL")
        return False

    ensure_paths()

    config = {
        "server_url": server_url,
        "listen_addr": "0.0.0.0:8080",
        "metrics_listen_addr": "127.0.0.1:9090",
        "grpc_listen_addr": "127.0.0.1:50443",
        "grpc_allow_insecure": True,
        "private_key_path": os.path.join(INSTANCE_DIR, "private.key"),
        "noise": {"private_key_path": os.path.join(INSTANCE_DIR, "noise_private.key")},
        "ip_prefixes": ["fd7a:115c:a1e0::/48", "100.64.0.0/10"],
        "db_type": "sqlite3",
        "db_path": HS_DB,
        "dns_config": {
            "magic_dns": True,
            "base_domain": "mesh.local",
            "nameservers": ["1.1.1.1", "8.8.8.8"],
            "override_local_dns": True,
            "extra_records": [
                {"name": "ghosthub.mesh.local", "type": "A", "value": "100.64.0.1"},
                {"name": "ghosthub", "type": "A", "value": "100.64.0.1"},
            ],
        },
        "derp": {
            "server": {
                "enabled": False,
            },
            "urls": [DEFAULT_DERP_MAP_URL],
            "paths": [],
            "auto_update_enabled": False,
            "update_frequency": "24h",
        },
        "disable_check_updates": True,
        "ephemeral_node_inactivity_timeout": "720h",
        "node_update_check_interval": "10s",
        "unix_socket": HS_SOCKET,
        "unix_socket_permission": "0770",
    }

    try:
        with open(HS_CONFIG, "w") as config_file:
            yaml.dump(config, config_file, default_flow_style=False)
        if not ensure_bootstrap_server_url(server_url):
            return False
        with open(HS_CONFIG, "r") as config_file:
            test_config = yaml.safe_load(config_file)
            logger.info(
                "Generated Headscale config at %s (db: %s)",
                HS_CONFIG,
                test_config.get('db_path'),
            )
        return True
    except Exception as err:
        logger.error("Failed to generate Headscale config: %s", err)
        return False


def get_config_server_url() -> Optional[str]:
    """Read the configured Headscale server_url from disk."""
    if yaml is None or not os.path.exists(HS_CONFIG):
        return None

    try:
        with open(HS_CONFIG, "r") as config_file:
            config = yaml.safe_load(config_file) or {}
        return config.get("server_url")
    except Exception as err:
        logger.warning("Failed to read Headscale server_url from %s: %s", HS_CONFIG, err)
        return None


def get_bootstrap_server_url() -> Optional[str]:
    """Read the persisted local enrollment URL used for initial client joins."""
    if not os.path.exists(HS_BOOTSTRAP_URL_PATH):
        return None

    try:
        with open(HS_BOOTSTRAP_URL_PATH, "r") as bootstrap_file:
            value = bootstrap_file.read().strip()
        normalized = normalize_server_url(value)
        if not normalized:
            return None

        # Validate that the cached IP address (if it's an IP) is still active on one of our network interfaces
        from urllib.parse import urlsplit
        import ipaddress
        parts = urlsplit(normalized)
        if parts.hostname:
            try:
                ipaddress.ip_address(parts.hostname)
                from app.services.system.network_detection_service import get_interface_ips
                interface_ips = get_interface_ips()
                active_ips = set(interface_ips.values())
                if parts.hostname not in active_ips:
                    logger.warning("Stale bootstrap URL detected: %s (IP is no longer active)", normalized)
                    return None
            except ValueError:
                # Hostname is not an IP address (e.g. domain name), keep it
                pass

        return normalized
    except Exception as err:
        logger.warning(
            "Failed to read Headscale bootstrap URL from %s: %s",
            HS_BOOTSTRAP_URL_PATH,
            err,
        )
        return None



def ensure_bootstrap_server_url(server_url: str) -> bool:
    """Persist the local enrollment URL separately from Headscale's live server_url."""
    try:
        server_url = normalize_server_url(server_url)
        if not server_url or is_invalid_bootstrap_server_url(server_url):
            logger.error("Refusing to persist invalid Headscale bootstrap URL: %s", server_url)
            return False

        os.makedirs(INSTANCE_DIR, exist_ok=True)
        current_value = get_bootstrap_server_url()
        if current_value == server_url:
            return True

        with open(HS_BOOTSTRAP_URL_PATH, "w") as bootstrap_file:
            bootstrap_file.write(server_url.strip())
        logger.info("Updated Headscale bootstrap URL to %s", server_url)
        return True
    except Exception as err:
        logger.error("Failed to persist Headscale bootstrap URL: %s", err)
        return False


def ensure_server_url(server_url: str) -> bool:
    """Ensure the persisted Headscale config advertises the expected server_url."""
    if yaml is None:
        logger.error("PyYAML module not available. Cannot update Headscale config.")
        return False

    server_url = normalize_server_url(server_url)
    if not server_url:
        logger.error("Cannot update Headscale server_url without a valid URL")
        return False

    if not os.path.exists(HS_CONFIG):
        return generate_config(server_url)

    try:
        with open(HS_CONFIG, "r") as config_file:
            config = yaml.safe_load(config_file) or {}

        if config.get("server_url") == server_url:
            return True

        config["server_url"] = server_url
        with open(HS_CONFIG, "w") as config_file:
            yaml.dump(config, config_file, default_flow_style=False)
        logger.info("Updated Headscale server_url to %s", server_url)
        return True
    except Exception as err:
        logger.error("Failed to update Headscale server_url: %s", err)
        return False


def repair_server_url_from_bootstrap() -> bool:
    """Repair poisoned live server_url values back to the persisted local bootstrap URL."""
    from app.services.system.network_detection_service import get_interface_ips
    interface_ips = get_interface_ips()
    active_ips = set(interface_ips.values())

    bootstrap_url = get_bootstrap_server_url()
    
    current_server_url = get_config_server_url()
    normalized_current = normalize_server_url(current_server_url)

    # Validate if current is active. If current is stale/invalid, we MUST repair it.
    current_is_valid_active = False
    if normalized_current and not is_invalid_bootstrap_server_url(normalized_current):
        from urllib.parse import urlsplit
        import ipaddress
        parts = urlsplit(normalized_current)
        if parts.hostname:
            try:
                ipaddress.ip_address(parts.hostname)
                if parts.hostname in active_ips:
                    current_is_valid_active = True
            except ValueError:
                # Hostname is not an IP address (e.g. domain name), assume OK
                current_is_valid_active = True
        else:
            current_is_valid_active = True

    if current_is_valid_active:
        return True

    # If we have a valid bootstrap URL, use it
    if bootstrap_url and not is_invalid_bootstrap_server_url(bootstrap_url):
        logger.warning(
            "Repairing Headscale server_url from %s back to bootstrap URL %s",
            current_server_url,
            bootstrap_url,
        )
        return ensure_server_url(bootstrap_url)

    # Fallback to the primary active network IP
    from app.utils.system_utils import get_local_ip
    primary_ip = interface_ips.get('eth0') or interface_ips.get('wlan0') or get_local_ip()
    fallback_url = f"http://{primary_ip}:8080"
    logger.warning(
        "Forcing stale Headscale server_url from %s to active IP fallback %s",
        current_server_url,
        fallback_url,
    )
    return ensure_server_url(fallback_url)



def ensure_derp_enabled() -> bool:
    """Keep embedded DERP disabled while ensuring clients still receive a DERP map."""
    if yaml is None:
        logger.error("PyYAML module not available. Cannot update DERP config.")
        return False

    if not os.path.exists(HS_CONFIG):
        return True

    try:
        with open(HS_CONFIG, "r") as config_file:
            config = yaml.safe_load(config_file) or {}

        derp = config.get("derp") or {}
        server = derp.get("server") or {}
        changed = False
        desired_paths = derp.get("paths") if isinstance(derp.get("paths"), list) else []
        desired_urls = []

        if isinstance(derp.get("urls"), list):
            for raw_url in derp.get("urls"):
                url = str(raw_url).strip()
                if url and url not in desired_urls:
                    desired_urls.append(url)

        if not desired_urls and not desired_paths:
            desired_urls = [DEFAULT_DERP_MAP_URL]

        if server.get("enabled") is not False:
            server["enabled"] = False
            changed = True

        for legacy_key in (
            "region_id",
            "region_code",
            "region_name",
            "stun_listen_addr",
            "ipv4",
            "ipv6",
        ):
            if legacy_key in server:
                del server[legacy_key]
                changed = True

        if derp.get("paths") != desired_paths:
            derp["paths"] = desired_paths
            changed = True

        if derp.get("urls") != desired_urls:
            derp["urls"] = desired_urls
            changed = True

        derp["server"] = server
        config["derp"] = derp

        if not changed:
            return True

        with open(HS_CONFIG, "w") as config_file:
            yaml.dump(config, config_file, default_flow_style=False)
        logger.info("Updated Headscale config to keep a DERP map while disabling embedded DERP")
        return True
    except Exception as err:
        logger.error("Failed to update Headscale DERP config: %s", err)
        return False
