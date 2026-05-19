"""USB user-data export/import service."""

import copy
import json
import logging
import os
import re
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import PurePosixPath, PureWindowsPath

from gevent.lock import BoundedSemaphore
from specter import Service

from app.services.core import config_service
from app.services.core.config_live_apply_service import apply_live_python_config
from app.services.core.database_bootstrap_service import ensure_database_ready
from app.services.core.schema_descriptor import (
    SCHEMA_VERSION,
    apply_migrations_to_rows,
    get_export_tables,
    get_import_order,
    get_required_columns,
    get_table_defaults,
    has_migration_path,
)
from app.services.core.sqlite_runtime_service import get_db
from app.version import VERSION

logger = logging.getLogger(__name__)

EXPORT_FORMAT = 'ghosthub-user-data-export'
EXPORT_FORMAT_VERSION = 1
BACKUP_DIR_NAME = 'GhostHubBackups'
EXPORT_FILENAME_RE = re.compile(r'^ghosthub-user-data-\d{8}-\d{6}(?:-\d+)?\.zip$')

MAX_EXPORT_ZIP_BYTES = 64 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
MAX_TABLE_JSON_BYTES = 64 * 1024 * 1024
MAX_CONFIG_JSON_BYTES = 2 * 1024 * 1024
MAX_ROWS_PER_TABLE = 250000
MAX_COMPRESSION_RATIO = 100
MIN_FREE_BYTES = 1024 * 1024
JOB_RETENTION_SECONDS = 60

_EXPORT_TABLES = get_export_tables()
_IMPORT_ORDER = get_import_order()

TABLE_MEMBERS = {
    table: f'tables/{table}.json'
    for table in _EXPORT_TABLES
}
REQUIRED_ZIP_MEMBERS = frozenset({
    'manifest.json',
    'ghosthub_config.json',
    *TABLE_MEMBERS.values(),
})
OPTIONAL_ZIP_MEMBERS = frozenset({
    'wifi_config.json',
})
ALLOWED_ZIP_MEMBERS = REQUIRED_ZIP_MEMBERS | OPTIONAL_ZIP_MEMBERS


class UserDataTransferError(Exception):
    """Expected user-data transfer failure."""


class UserDataTransferService(Service):
    """Own USB user data export/import workflows and polling job state."""

    def __init__(self):
        super().__init__('user_data_transfer', {'jobs': {}})
        self.priority = 80
        self._jobs_lock = BoundedSemaphore(1)
        self._transfer_lock = BoundedSemaphore(1)
        self._jobs = {}

    def list_drives(self):
        """Return detected drives with labels and formatted sizes."""
        from app.services.storage import drive_label_service, storage_drive_service
        from app.services.storage import storage_io_service

        drives = storage_drive_service.get_storage_drives(force_refresh=False)
        if not drives:
            drives = storage_drive_service.get_storage_drives_fresh()
        else:
            storage_drive_service.get_storage_drives(force_refresh=True)

        labels = drive_label_service.get_all_drive_labels()
        result = []
        for drive in drives:
            item = {
                'id': drive.get('id'),
                'name': drive.get('name'),
                'label': labels.get(drive.get('device_key')) if drive.get('device_key') else None,
                'path': drive.get('path'),
                'writable': bool(drive.get('writable', False)),
                'free': int(drive.get('free') or 0),
                'free_formatted': storage_io_service.format_bytes(int(drive.get('free') or 0)),
                'total': int(drive.get('total') or 0),
                'total_formatted': storage_io_service.format_bytes(int(drive.get('total') or 0)),
                'device_key': drive.get('device_key'),
            }
            result.append(item)

        return result

    def list_exports(self, drive_id):
        """List valid GhostHub export zips on a detected drive."""
        from app.services.storage import storage_io_service

        drive = self._resolve_drive(drive_id)
        backup_dir = self._backup_dir_for_drive(drive)
        if not os.path.isdir(backup_dir):
            return []

        exports = []
        for entry in os.scandir(backup_dir):
            if not entry.is_file() or not entry.name.endswith('.zip'):
                continue
            if not EXPORT_FILENAME_RE.match(entry.name):
                continue
            try:
                export_path = self._resolve_export_path(drive, entry.name, must_exist=True)
                validation = self._validate_export_zip(export_path, load_payload=False)
                manifest = validation['manifest']
                stat = entry.stat()
                exports.append({
                    'filename': entry.name,
                    'size': stat.st_size,
                    'size_formatted': storage_io_service.format_bytes(stat.st_size),
                    'manifest': {
                        'schema_version': manifest.get('schema_version'),
                        'ghosthub_version': manifest.get('ghosthub_version'),
                        'exported_at': manifest.get('exported_at'),
                    },
                })
            except UserDataTransferError as exc:
                logger.info("Skipping invalid GhostHub export %s: %s", entry.name, exc)
            except OSError as exc:
                logger.info("Could not inspect export %s: %s", entry.name, exc)

        exports.sort(key=lambda item: item['filename'], reverse=True)
        return exports

    def start_export(self, drive_id):
        """Create an export background job."""
        drive = self._resolve_drive(drive_id, require_writable=True)
        if int(drive.get('free') or 0) < MIN_FREE_BYTES:
            raise UserDataTransferError('Selected drive does not have enough free space.')

        job = self._create_job('export')
        self.spawn(self._run_export_job, job['id'], drive_id, label='user-data-export')
        return job['id']

    def start_import(self, drive_id, filename):
        """Create an import background job."""
        drive = self._resolve_drive(drive_id)
        self._resolve_export_path(drive, filename, must_exist=True)

        job = self._create_job('import')
        self.spawn(self._run_import_job, job['id'], drive_id, filename, label='user-data-import')
        return job['id']

    def get_job(self, job_id):
        """Return a copy of a tracked job."""
        with self._jobs_lock:
            job = self._jobs.get(job_id)
            return copy.deepcopy(job) if job else None

    def delete_export(self, drive_id, filename):
        """Delete one validated GhostHub export zip from a writable drive."""
        drive = self._resolve_drive(drive_id, require_writable=True)
        export_path = self._resolve_export_path(drive, filename, must_exist=True)
        self._validate_export_zip(export_path, load_payload=False)
        os.remove(export_path)
        return True

    def _run_export_job(self, job_id, drive_id):
        try:
            with self._transfer_lock:
                result = self._create_export(job_id, drive_id)
            self._complete_job(job_id, {
                'message': 'Exported user data successfully.',
                'result': result,
            })
        except Exception as exc:
            logger.error("User data export failed: %s", exc)
            self._fail_job(job_id, _public_error(exc))

    def _run_import_job(self, job_id, drive_id, filename):
        try:
            with self._transfer_lock:
                result = self._import_export(job_id, drive_id, filename)
            self._complete_job(job_id, {
                'message': result.get('message', 'Imported user data successfully.'),
                'result': result,
            })
        except Exception as exc:
            logger.error("User data import failed: %s", exc)
            self._fail_job(job_id, _public_error(exc))

    def _create_export(self, job_id, drive_id):
        drive = self._resolve_drive(drive_id, require_writable=True)
        if int(drive.get('free') or 0) < MIN_FREE_BYTES:
            raise UserDataTransferError('Selected drive does not have enough free space.')

        backup_dir = self._backup_dir_for_drive(drive)
        os.makedirs(backup_dir, exist_ok=True)
        filename = self._next_export_filename(backup_dir)
        final_path = os.path.join(backup_dir, filename)
        temp_path = os.path.join(backup_dir, f'.{filename}.tmp')

        self._update_job(job_id, step='Reading config', progress=10)
        exported_config = self._read_export_config()
        exported_wifi_config = self._read_export_wifi_config()
        export_drives = self._get_export_drive_snapshot()

        row_counts = {}
        self._update_job(job_id, step='Counting rows', progress=15)
        with get_db() as conn:
            try:
                conn.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchall()
            except Exception as exc:
                logger.warning("Could not checkpoint WAL before user-data export: %s", exc)
            for table in _EXPORT_TABLES:
                row_counts[table] = self._count_rows(conn, table)

            manifest = self._build_manifest(row_counts, export_drives)
            with zipfile.ZipFile(temp_path, 'w', compression=zipfile.ZIP_DEFLATED) as export_zip:
                export_zip.writestr('manifest.json', _json_bytes(manifest))
                export_zip.writestr('ghosthub_config.json', _json_bytes(exported_config))
                export_zip.writestr('wifi_config.json', _json_bytes(exported_wifi_config))

                total_tables = len(_EXPORT_TABLES)
                for index, table in enumerate(_EXPORT_TABLES, start=1):
                    self._update_job(
                        job_id,
                        step=f'Writing {table}',
                        progress=15 + int((index / total_tables) * 75),
                    )
                    self._write_table_json(export_zip, conn, table)

        size = os.path.getsize(temp_path)
        if size > MAX_EXPORT_ZIP_BYTES:
            try:
                os.remove(temp_path)
            except OSError:
                pass
            raise UserDataTransferError('Export is too large to write safely.')

        os.replace(temp_path, final_path)
        self._update_job(job_id, step='Export complete', progress=100)
        return {
            'filename': filename,
            'drive_id': drive.get('id'),
            'drive_name': drive.get('label') or drive.get('name'),
            'size': os.path.getsize(final_path),
            'rows_exported': row_counts,
        }

    def _import_export(self, job_id, drive_id, filename):
        drive = self._resolve_drive(drive_id)
        export_path = self._resolve_export_path(drive, filename, must_exist=True)

        self._update_job(job_id, step='Validating export zip', progress=10)
        validated = self._validate_export_zip(export_path, load_payload=True)

        self._update_job(job_id, step='Preparing database', progress=25)
        ensure_database_ready()
        manifest_schema = validated['manifest'].get('schema_version')
        if manifest_schema > SCHEMA_VERSION:
            raise UserDataTransferError(
                f'Export schema version {manifest_schema} is newer than this device ({SCHEMA_VERSION}). Update GhostHub before importing.'
            )
        if manifest_schema < SCHEMA_VERSION:
            if not has_migration_path(manifest_schema):
                raise UserDataTransferError(
                    f'Unsupported export schema version {manifest_schema}; this device expects {SCHEMA_VERSION}.'
                )
            apply_migrations_to_rows(validated['tables'], from_version=manifest_schema)

        self._update_job(job_id, step='Importing rows', progress=35)
        rows_imported = self._upsert_tables(validated['tables'])
        warnings = []

        self._update_job(job_id, step='Saving config', progress=85)
        config_success, config_message = self._merge_and_save_config(validated['config'])
        if not config_success:
            warnings.append(f'Config was not restored: {config_message}')

        wifi_config = validated.get('wifi_config')
        if wifi_config:
            wifi_success, wifi_message = self._save_wifi_config(wifi_config)
            if not wifi_success:
                warnings.append(f'WiFi config was not restored: {wifi_message}')

        self._update_job(job_id, step='Refreshing caches', progress=95)
        self._invalidate_after_import()

        message = 'Imported user data successfully.'
        if warnings:
            message = 'Imported database rows, but some settings were not restored.'

        self._update_job(job_id, step='Import complete', progress=100)
        return {
            'filename': os.path.basename(filename),
            'rows_imported': rows_imported,
            'warnings': warnings,
            'message': message,
        }

    def _resolve_drive(self, drive_id, require_writable=False):
        if not drive_id or not isinstance(drive_id, str):
            raise UserDataTransferError('drive_id is required.')

        from app.services.storage import storage_drive_service

        drives = storage_drive_service.get_storage_drives(force_refresh=False)
        if not drives:
            drives = storage_drive_service.get_storage_drives_fresh()

        for drive in drives:
            if drive.get('id') != drive_id:
                continue
            if require_writable and not drive.get('writable', False):
                raise UserDataTransferError('Selected drive is not writable.')
            if not drive.get('path'):
                raise UserDataTransferError('Selected drive is not available.')
            return dict(drive)

        raise UserDataTransferError('Selected drive is not available.')

    def _backup_dir_for_drive(self, drive):
        drive_path = os.path.realpath(drive.get('path'))
        return os.path.join(drive_path, BACKUP_DIR_NAME)

    def _resolve_export_path(self, drive, filename, must_exist=False):
        if not isinstance(filename, str) or not filename:
            raise UserDataTransferError('filename is required.')
        if os.path.basename(filename) != filename or '/' in filename or '\\' in filename:
            raise UserDataTransferError('Invalid export filename.')
        if not EXPORT_FILENAME_RE.match(filename):
            raise UserDataTransferError('Invalid export filename.')

        backup_dir = self._backup_dir_for_drive(drive)
        target = os.path.realpath(os.path.join(backup_dir, filename))
        backup_real = os.path.realpath(backup_dir)
        if target != os.path.join(backup_real, filename):
            raise UserDataTransferError('Invalid export path.')
        if not _is_within(backup_real, target):
            raise UserDataTransferError('Invalid export path.')
        if must_exist and not os.path.isfile(target):
            raise UserDataTransferError('Export file not found.')
        return target

    def _next_export_filename(self, backup_dir):
        stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
        base = f'ghosthub-user-data-{stamp}'
        filename = f'{base}.zip'
        counter = 2
        while os.path.exists(os.path.join(backup_dir, filename)):
            filename = f'{base}-{counter}.zip'
            counter += 1
        return filename

    def _read_export_config(self):
        config_data, error = config_service.load_config()
        if error:
            logger.warning("Exporting normalized default config after config load warning: %s", error)

        self._validate_config(config_data)
        return config_data

    def _read_export_wifi_config(self):
        from app.services.system.wifi.config_service import get_wifi_config

        wifi_config, _error = get_wifi_config()
        self._validate_wifi_config(wifi_config)
        return wifi_config

    def _get_export_drive_snapshot(self):
        from app.services.storage import drive_label_service, storage_drive_service

        drives = storage_drive_service.get_storage_drives(force_refresh=False)
        if not drives:
            drives = storage_drive_service.get_storage_drives_fresh()
        labels = drive_label_service.get_all_drive_labels()

        snapshot = []
        for drive in drives:
            device_key = drive.get('device_key')
            path = drive.get('path')
            if not device_key or not path:
                continue
            snapshot.append({
                'device_key': str(device_key),
                'name': str(drive.get('name') or ''),
                'path': os.path.realpath(path),
                'label': labels.get(device_key),
            })
        return snapshot

    def _build_manifest(self, row_counts, drives=None):
        return {
            'format': EXPORT_FORMAT,
            'format_version': EXPORT_FORMAT_VERSION,
            'schema_version': SCHEMA_VERSION,
            'ghosthub_version': VERSION,
            'exported_at': datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
            'drives': drives or [],
            'tables': {
                table: {'row_count': int(row_counts.get(table, 0))}
                for table in _EXPORT_TABLES
            },
        }

    def _count_rows(self, conn, table):
        row = conn.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()
        return int(row['count'] if row else 0)

    def _write_table_json(self, export_zip, conn, table):
        columns = _EXPORT_TABLES[table]
        query = f"SELECT {', '.join(columns)} FROM {table}"
        rows = conn.execute(query).fetchall()
        payload = [
            {column: row[column] for column in columns}
            for row in rows
        ]
        export_zip.writestr(TABLE_MEMBERS[table], _json_bytes(payload))

    def _validate_export_zip(self, export_path, load_payload=False):
        if os.path.getsize(export_path) > MAX_EXPORT_ZIP_BYTES:
            raise UserDataTransferError('Export zip is too large.')

        try:
            with zipfile.ZipFile(export_path, 'r') as export_zip:
                self._validate_zip_members(export_zip)
                manifest = self._read_json_member(export_zip, 'manifest.json', MAX_CONFIG_JSON_BYTES)
                self._validate_manifest(manifest)

                result = {'manifest': manifest}
                if load_payload:
                    config_data = self._read_json_member(
                        export_zip,
                        'ghosthub_config.json',
                        MAX_CONFIG_JSON_BYTES,
                    )
                    self._validate_config(config_data)
                    tables = {}
                    for table, member_name in TABLE_MEMBERS.items():
                        rows = self._read_json_member(export_zip, member_name, MAX_TABLE_JSON_BYTES)
                        tables[table] = self._validate_table_rows(table, rows)
                    self._normalize_tables_for_current_drives(manifest, tables)
                    result['config'] = config_data
                    result['tables'] = tables
                    if 'wifi_config.json' in export_zip.namelist():
                        wifi_config = self._read_json_member(
                            export_zip,
                            'wifi_config.json',
                            MAX_CONFIG_JSON_BYTES,
                        )
                        self._validate_wifi_config(wifi_config)
                        result['wifi_config'] = wifi_config
                return result
        except zipfile.BadZipFile as exc:
            raise UserDataTransferError('Export zip is invalid.') from exc

    def _validate_zip_members(self, export_zip):
        infos = export_zip.infolist()
        names = []
        total_uncompressed = 0

        for info in infos:
            name = info.filename
            self._validate_member_name(name)
            if _is_zip_symlink(info):
                raise UserDataTransferError('Export zip contains an unsupported link entry.')
            if name in names:
                raise UserDataTransferError('Export zip contains duplicate entries.')
            names.append(name)

            total_uncompressed += int(info.file_size)
            if total_uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES:
                raise UserDataTransferError('Export zip is too large when uncompressed.')
            if info.compress_size == 0 and info.file_size > 0:
                raise UserDataTransferError('Export zip compression metadata is suspicious.')
            if info.compress_size > 0 and info.file_size > 1024 * 1024:
                ratio = info.file_size / info.compress_size
                if ratio > MAX_COMPRESSION_RATIO:
                    raise UserDataTransferError('Export zip compression ratio is suspicious.')

            if name not in ALLOWED_ZIP_MEMBERS:
                raise UserDataTransferError(f'Export zip contains unexpected file: {name}')

        member_set = set(names)
        missing = sorted(REQUIRED_ZIP_MEMBERS - member_set)
        if missing:
            raise UserDataTransferError(f'Export zip is missing required file: {missing[0]}')

    def _validate_member_name(self, name):
        if not name:
            raise UserDataTransferError('Export zip contains an empty member name.')
        if name.startswith('/'):
            raise UserDataTransferError('Export zip contains an absolute path.')
        if '\\' in name:
            raise UserDataTransferError('Export zip contains an invalid path separator.')
        if PureWindowsPath(name).drive:
            raise UserDataTransferError('Export zip contains a Windows drive path.')

        parts = PurePosixPath(name).parts
        if any(part in ('', '.', '..') for part in parts):
            raise UserDataTransferError('Export zip contains an unsafe path.')

    def _read_json_member(self, export_zip, member_name, max_bytes):
        info = export_zip.getinfo(member_name)
        if info.file_size > max_bytes:
            raise UserDataTransferError(f'{member_name} is too large.')
        raw = export_zip.read(member_name)
        if len(raw) > max_bytes:
            raise UserDataTransferError(f'{member_name} is too large.')
        try:
            return json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise UserDataTransferError(f'{member_name} is not valid JSON.') from exc

    def _validate_manifest(self, manifest):
        if not isinstance(manifest, dict):
            raise UserDataTransferError('Export manifest is invalid.')
        if manifest.get('format') != EXPORT_FORMAT:
            raise UserDataTransferError('Export format is not supported.')
        if manifest.get('format_version') != EXPORT_FORMAT_VERSION:
            raise UserDataTransferError('Export format version is not supported.')
        if not isinstance(manifest.get('schema_version'), int):
            raise UserDataTransferError('Export manifest schema version is invalid.')
        if not isinstance(manifest.get('ghosthub_version'), str):
            raise UserDataTransferError('Export manifest GhostHub version is invalid.')
        if not isinstance(manifest.get('exported_at'), str):
            raise UserDataTransferError('Export manifest timestamp is invalid.')

        tables = manifest.get('tables')
        if not isinstance(tables, dict):
            raise UserDataTransferError('Export manifest table metadata is invalid.')
        for table in _EXPORT_TABLES:
            table_meta = tables.get(table)
            if not isinstance(table_meta, dict) or not isinstance(table_meta.get('row_count'), int):
                raise UserDataTransferError(f'Export manifest is missing table metadata for {table}.')

    def _validate_config(self, config_data):
        if not isinstance(config_data, dict):
            raise UserDataTransferError('Config export is invalid.')
        if not isinstance(config_data.get('python_config'), dict):
            raise UserDataTransferError('Config export is missing python_config.')
        if not isinstance(config_data.get('javascript_config'), dict):
            raise UserDataTransferError('Config export is missing javascript_config.')

    def _validate_wifi_config(self, wifi_config):
        if not isinstance(wifi_config, dict):
            raise UserDataTransferError('WiFi config export is invalid.')

        ssid = wifi_config.get('ssid')
        password = wifi_config.get('password')
        channel = wifi_config.get('channel')
        country_code = wifi_config.get('country_code')

        if not isinstance(ssid, str) or not 1 <= len(ssid) <= 32:
            raise UserDataTransferError('WiFi config SSID is invalid.')
        if not isinstance(password, str) or not 8 <= len(password) <= 63:
            raise UserDataTransferError('WiFi config password is invalid.')
        if not isinstance(channel, int) or not 1 <= channel <= 11:
            raise UserDataTransferError('WiFi config channel is invalid.')
        if not isinstance(country_code, str) or len(country_code) != 2:
            raise UserDataTransferError('WiFi config country code is invalid.')

    def _save_wifi_config(self, wifi_config):
        from app.services.system.wifi.runtime_service import save_wifi_config

        return save_wifi_config(
            ssid=wifi_config.get('ssid'),
            password=wifi_config.get('password'),
            channel=wifi_config.get('channel'),
            country_code=wifi_config.get('country_code'),
        )

    def _normalize_tables_for_current_drives(self, manifest, tables):
        remaps = self._build_drive_path_remaps(manifest)
        if not remaps:
            return

        category_id_rewrites = {}
        for row in tables.get('categories', []):
            old_id = str(row.get('id') or '')
            new_path = self._rewrite_path_for_current_drive(row.get('path'), remaps)
            if new_path != row.get('path'):
                row['path'] = new_path

            new_id = self._rewrite_category_id_for_current_drive(old_id, remaps)
            if new_id and new_id != old_id:
                row['id'] = new_id
                category_id_rewrites[old_id] = new_id

        for row in tables.get('hidden_categories', []):
            category_id = row.get('category_id')
            if category_id is not None:
                row['category_id'] = category_id_rewrites.get(
                    str(category_id),
                    self._rewrite_category_id_for_current_drive(str(category_id), remaps),
                )

        for row in tables.get('hidden_files', []):
            row['file_path'] = self._rewrite_path_for_current_drive(row.get('file_path'), remaps)
            category_id = row.get('category_id')
            if category_id is not None:
                row['category_id'] = category_id_rewrites.get(
                    str(category_id),
                    self._rewrite_category_id_for_current_drive(str(category_id), remaps),
                )

        for row in tables.get('video_progress', []):
            row['video_path'] = self._rewrite_path_for_current_drive(row.get('video_path'), remaps)
            category_id = row.get('category_id')
            if category_id is not None:
                row['category_id'] = category_id_rewrites.get(
                    str(category_id),
                    self._rewrite_category_id_for_current_drive(str(category_id), remaps),
                )

    def _build_drive_path_remaps(self, manifest):
        exported_drives = manifest.get('drives')
        if not isinstance(exported_drives, list):
            return []

        from app.services.storage import storage_drive_service, storage_path_service

        current_drives = storage_drive_service.get_storage_drives(force_refresh=False)
        if not current_drives:
            current_drives = storage_drive_service.get_storage_drives_fresh()

        current_by_device_key = {}
        for drive in current_drives:
            device_key = drive.get('device_key')
            path = drive.get('path')
            if device_key and path:
                current_by_device_key[str(device_key)] = os.path.realpath(path)

        remaps = []
        for exported_drive in exported_drives:
            if not isinstance(exported_drive, dict):
                continue
            device_key = exported_drive.get('device_key')
            old_path = exported_drive.get('path')
            if not device_key or not old_path:
                continue

            new_path = current_by_device_key.get(str(device_key))
            if not new_path:
                continue

            old_path = os.path.normpath(str(old_path))
            new_path = os.path.normpath(str(new_path))
            if old_path == new_path:
                continue

            old_category_id = storage_path_service.get_category_id_from_path(old_path)
            new_category_id = storage_path_service.get_category_id_from_path(new_path)
            remaps.append({
                'old_path': old_path,
                'new_path': new_path,
                'old_category_id': old_category_id,
                'new_category_id': new_category_id,
            })

        remaps.sort(key=lambda item: len(item['old_path']), reverse=True)
        return remaps

    def _rewrite_path_for_current_drive(self, value, remaps):
        if not isinstance(value, str) or not value:
            return value

        path = os.path.normpath(value)
        for remap in remaps:
            old_path = remap['old_path']
            if path == old_path:
                return remap['new_path']
            if path.startswith(old_path + os.sep):
                suffix = path[len(old_path):]
                return remap['new_path'] + suffix
        return value

    def _rewrite_category_id_for_current_drive(self, category_id, remaps):
        if not isinstance(category_id, str) or not category_id:
            return category_id

        for remap in remaps:
            old_category_id = remap.get('old_category_id')
            new_category_id = remap.get('new_category_id')
            if not old_category_id or not new_category_id:
                continue
            if category_id == old_category_id:
                return new_category_id
            prefix = old_category_id + '::'
            if category_id.startswith(prefix):
                return new_category_id + category_id[len(old_category_id):]
        return category_id

    def _validate_table_rows(self, table, rows):
        if not isinstance(rows, list):
            raise UserDataTransferError(f'{table} export must be a JSON array.')
        if len(rows) > MAX_ROWS_PER_TABLE:
            raise UserDataTransferError(f'{table} export has too many rows.')

        allowed = set(_EXPORT_TABLES[table])
        required = get_required_columns(table)
        defaults = get_table_defaults(table)
        normalized = []
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise UserDataTransferError(f'{table} row {index + 1} is invalid.')
            unknown = set(row) - allowed
            if unknown:
                logger.warning(
                    "Ignoring unknown columns in %s export row %s: %s",
                    table,
                    index + 1,
                    ', '.join(sorted(unknown)),
                )
                row = {key: value for key, value in row.items() if key in allowed}
            missing_required = [
                column
                for column in required
                if row.get(column) in (None, '')
            ]
            if missing_required:
                raise UserDataTransferError(
                    f'{table} row {index + 1} is missing required columns.'
                )

            normalized_row = {}
            for column in _EXPORT_TABLES[table]:
                if column in row:
                    normalized_row[column] = row[column]
                else:
                    normalized_row[column] = defaults.get(column)
            normalized.append(normalized_row)

        return normalized

    def _upsert_tables(self, tables):
        rows_imported = {table: 0 for table in _EXPORT_TABLES}
        profile_id_map = {}
        category_id_map = {}

        with get_db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                for table in _IMPORT_ORDER:
                    if table == 'profiles':
                        rows_imported[table] = self._upsert_profiles(conn, tables[table], profile_id_map)
                    elif table == 'categories':
                        rows_imported[table] = self._upsert_categories(conn, tables[table], category_id_map)
                    elif table == 'drive_labels':
                        rows_imported[table] = self._upsert_drive_labels(conn, tables[table])
                    elif table == 'hidden_categories':
                        rows_imported[table] = self._upsert_hidden_categories(conn, tables[table], category_id_map)
                    elif table == 'hidden_files':
                        rows_imported[table] = self._upsert_hidden_files(conn, tables[table], category_id_map)
                    elif table == 'video_progress':
                        rows_imported[table] = self._upsert_video_progress(
                            conn,
                            tables[table],
                            profile_id_map,
                            category_id_map,
                        )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise

        return rows_imported

    def _upsert_profiles(self, conn, rows, profile_id_map):
        count = 0
        for row in rows:
            imported_id = str(row['id'])
            name = str(row['name'])
            existing_by_id = conn.execute(
                "SELECT id, last_active_at FROM profiles WHERE id = ?",
                (imported_id,),
            ).fetchone()
            existing_by_name = conn.execute(
                "SELECT id, last_active_at FROM profiles WHERE name = ? COLLATE NOCASE",
                (name,),
            ).fetchone()

            if existing_by_id:
                actual_id = existing_by_id['id']
                if existing_by_name and existing_by_name['id'] != actual_id:
                    raise UserDataTransferError(
                        f'Profile name conflict cannot be safely imported: {name}'
                    )
                conn.execute(
                    """
                    UPDATE profiles
                    SET name = ?,
                        avatar_color = ?,
                        avatar_icon = ?,
                        preferences_json = ?,
                        created_at = ?,
                        last_active_at = MAX(COALESCE(last_active_at, 0), ?)
                    WHERE id = ?
                    """,
                    (
                        name,
                        row.get('avatar_color'),
                        row.get('avatar_icon'),
                        row.get('preferences_json'),
                        _number(row.get('created_at'), 0),
                        _number(row.get('last_active_at'), 0),
                        actual_id,
                    ),
                )
            elif existing_by_name:
                actual_id = existing_by_name['id']
                conn.execute(
                    """
                    UPDATE profiles
                    SET avatar_color = ?,
                        avatar_icon = ?,
                        preferences_json = ?,
                        created_at = MIN(COALESCE(created_at, ?), ?),
                        last_active_at = MAX(COALESCE(last_active_at, 0), ?)
                    WHERE id = ?
                    """,
                    (
                        row.get('avatar_color'),
                        row.get('avatar_icon'),
                        row.get('preferences_json'),
                        _number(row.get('created_at'), 0),
                        _number(row.get('created_at'), 0),
                        _number(row.get('last_active_at'), 0),
                        actual_id,
                    ),
                )
            else:
                actual_id = imported_id
                conn.execute(
                    """
                    INSERT INTO profiles (
                        id, name, avatar_color, avatar_icon, preferences_json,
                        created_at, last_active_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        imported_id,
                        name,
                        row.get('avatar_color'),
                        row.get('avatar_icon'),
                        row.get('preferences_json'),
                        _number(row.get('created_at'), 0),
                        _number(row.get('last_active_at'), 0),
                    ),
                )

            profile_id_map[imported_id] = actual_id
            count += 1
        return count

    def _upsert_categories(self, conn, rows, category_id_map):
        count = 0
        for row in rows:
            imported_id = str(row['id'])
            path = str(row['path'])
            existing_by_id = conn.execute(
                "SELECT id FROM categories WHERE id = ?",
                (imported_id,),
            ).fetchone()
            existing_by_path = conn.execute(
                "SELECT id FROM categories WHERE path = ?",
                (path,),
            ).fetchone()

            if existing_by_id:
                actual_id = existing_by_id['id']
                if existing_by_path and existing_by_path['id'] != actual_id:
                    raise UserDataTransferError(
                        f'Category path conflict cannot be safely imported: {path}'
                    )
                conn.execute(
                    """
                    UPDATE categories
                    SET name = ?,
                        path = ?,
                        is_manual = ?,
                        version_hash = ?,
                        created_at = ?,
                        updated_at = MAX(COALESCE(updated_at, 0), ?)
                    WHERE id = ?
                    """,
                    (
                        str(row['name']),
                        path,
                        1 if row.get('is_manual') else 0,
                        row.get('version_hash'),
                        _number(row.get('created_at'), 0),
                        _number(row.get('updated_at'), 0),
                        actual_id,
                    ),
                )
            elif existing_by_path:
                actual_id = existing_by_path['id']
                conn.execute(
                    """
                    UPDATE categories
                    SET name = ?,
                        is_manual = ?,
                        version_hash = ?,
                        created_at = MIN(COALESCE(created_at, ?), ?),
                        updated_at = MAX(COALESCE(updated_at, 0), ?)
                    WHERE id = ?
                    """,
                    (
                        str(row['name']),
                        1 if row.get('is_manual') else 0,
                        row.get('version_hash'),
                        _number(row.get('created_at'), 0),
                        _number(row.get('created_at'), 0),
                        _number(row.get('updated_at'), 0),
                        actual_id,
                    ),
                )
            else:
                actual_id = imported_id
                conn.execute(
                    """
                    INSERT INTO categories (
                        id, name, path, is_manual, version_hash, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        imported_id,
                        str(row['name']),
                        path,
                        1 if row.get('is_manual') else 0,
                        row.get('version_hash'),
                        _number(row.get('created_at'), 0),
                        _number(row.get('updated_at'), 0),
                    ),
                )

            category_id_map[imported_id] = actual_id
            count += 1
        return count

    def _upsert_drive_labels(self, conn, rows):
        for row in rows:
            conn.execute(
                """
                INSERT INTO drive_labels (device_key, label, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(device_key) DO UPDATE SET
                    label = excluded.label,
                    updated_at = excluded.updated_at
                """,
                (
                    str(row['device_key']),
                    str(row['label']),
                    _number(row.get('updated_at'), 0),
                ),
            )
        return len(rows)

    def _upsert_hidden_categories(self, conn, rows, category_id_map):
        count = 0
        for row in rows:
            category_id = category_id_map.get(str(row['category_id']), str(row['category_id']))
            conn.execute(
                """
                INSERT INTO hidden_categories (category_id, hidden_at, hidden_by)
                VALUES (?, ?, ?)
                ON CONFLICT(category_id) DO UPDATE SET
                    hidden_at = excluded.hidden_at,
                    hidden_by = excluded.hidden_by
                """,
                (
                    category_id,
                    _number(row.get('hidden_at'), 0),
                    row.get('hidden_by'),
                ),
            )
            count += 1
        return count

    def _upsert_hidden_files(self, conn, rows, category_id_map):
        count = 0
        for row in rows:
            category_id = row.get('category_id')
            if category_id is not None:
                category_id = category_id_map.get(str(category_id), str(category_id))
            conn.execute(
                """
                INSERT INTO hidden_files (file_path, category_id, hidden_at, hidden_by)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(file_path) DO UPDATE SET
                    category_id = excluded.category_id,
                    hidden_at = excluded.hidden_at,
                    hidden_by = excluded.hidden_by
                """,
                (
                    str(row['file_path']),
                    category_id,
                    _number(row.get('hidden_at'), 0),
                    row.get('hidden_by'),
                ),
            )
            count += 1
        return count

    def _upsert_video_progress(self, conn, rows, profile_id_map, category_id_map):
        count = 0
        for row in rows:
            imported_profile_id = str(row['profile_id'])
            profile_id = profile_id_map.get(imported_profile_id, imported_profile_id)
            category_id = row.get('category_id')
            if category_id is not None:
                category_id = category_id_map.get(str(category_id), str(category_id))
            conn.execute(
                """
                INSERT INTO video_progress (
                    video_path,
                    profile_id,
                    category_id,
                    video_timestamp,
                    video_duration,
                    thumbnail_url,
                    last_watched,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(video_path, profile_id) DO UPDATE SET
                    category_id = excluded.category_id,
                    video_timestamp = excluded.video_timestamp,
                    video_duration = excluded.video_duration,
                    thumbnail_url = excluded.thumbnail_url,
                    last_watched = excluded.last_watched,
                    updated_at = excluded.updated_at
                WHERE COALESCE(excluded.updated_at, 0) >= COALESCE(video_progress.updated_at, 0)
                """,
                (
                    str(row['video_path']),
                    profile_id,
                    category_id,
                    _nullable_number(row.get('video_timestamp')),
                    _nullable_number(row.get('video_duration')),
                    row.get('thumbnail_url'),
                    _number(row.get('last_watched'), 0),
                    _number(row.get('updated_at'), 0),
                ),
            )
            count += 1
        return count

    def _merge_and_save_config(self, imported_config):
        current_config, _error = config_service.load_config()
        merged = _deep_merge(config_service.get_default_config(), current_config)
        merged = _deep_merge(merged, imported_config)
        success, message = config_service.save_config(merged)
        if success:
            apply_live_python_config(merged.get('python_config', {}))
        return success, message

    def _invalidate_after_import(self):
        try:
            from app.services.media.category_cache_service import invalidate_cache

            invalidate_cache()
        except Exception as exc:
            logger.warning("Category cache invalidation failed after import: %s", exc)

        try:
            from app.services.media.hidden_content_service import invalidate_hidden_content_caches

            invalidate_hidden_content_caches()
        except Exception as exc:
            logger.warning("Hidden content cache invalidation failed after import: %s", exc)

        try:
            from app.services.storage import storage_drive_service

            storage_drive_service.get_storage_drives_fresh()
        except Exception as exc:
            logger.warning("Drive cache refresh failed after import: %s", exc)

    def _create_job(self, job_type):
        now = time.time()
        job = {
            'id': str(uuid.uuid4()),
            'type': job_type,
            'status': 'queued',
            'step': 'Queued',
            'progress': 0,
            'created_at': now,
            'updated_at': now,
        }
        with self._jobs_lock:
            self._jobs[job['id']] = job
            self.set_state({'jobs': copy.deepcopy(self._jobs)})
        return dict(job)

    def _update_job(self, job_id, **updates):
        with self._jobs_lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            job.update(updates)
            job['updated_at'] = time.time()
            if job.get('status') == 'queued' and updates.get('step') != 'Queued':
                job['status'] = 'running'
            self.set_state({'jobs': copy.deepcopy(self._jobs)})

    def _complete_job(self, job_id, updates):
        payload = dict(updates)
        payload.update({'status': 'complete', 'progress': 100})
        self._update_job(job_id, **payload)
        self._schedule_job_cleanup(job_id)

    def _fail_job(self, job_id, error):
        self._update_job(job_id, status='error', error=error, progress=0)
        self._schedule_job_cleanup(job_id)

    def _schedule_job_cleanup(self, job_id):
        """Drop a finished job after the polling client has had time to read it."""
        self.timeout(lambda: self._remove_job(job_id), JOB_RETENTION_SECONDS)

    def _remove_job(self, job_id):
        with self._jobs_lock:
            if self._jobs.pop(job_id, None) is not None:
                self.set_state({'jobs': copy.deepcopy(self._jobs)})


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def _is_zip_symlink(info):
    file_type = (info.external_attr >> 16) & 0o170000
    return file_type == 0o120000


def _is_within(parent, child):
    parent_real = os.path.realpath(parent)
    child_real = os.path.realpath(child)
    try:
        return os.path.commonpath([parent_real, child_real]) == parent_real
    except ValueError:
        return False


def _deep_merge(base, overlay):
    if not isinstance(base, dict):
        base = {}
    if not isinstance(overlay, dict):
        return copy.deepcopy(base)

    result = copy.deepcopy(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _number(value, default):
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _nullable_number(value):
    if value is None:
        return None
    return _number(value, 0)


def _public_error(exc):
    if isinstance(exc, UserDataTransferError):
        return str(exc)
    return 'User data transfer failed.'
