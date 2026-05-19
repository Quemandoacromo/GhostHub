"""Tests for USB user data transfer service."""

import json
import os
import zipfile

import pytest

from app.services.core.database_schema_service import SCHEMA_VERSION
from app.version import VERSION
from tests.conftest import register_test_storage_drive


def _service():
    from specter import registry

    return registry.require('user_data_transfer')


def _write_export_zip(path, *, schema_version=SCHEMA_VERSION, members=None, drives=None, wifi_config=None):
    from app.services.core.schema_descriptor import get_export_tables
    from app.services.system.user_data_transfer_service import TABLE_MEMBERS

    export_tables = get_export_tables()
    table_payloads = {table: [] for table in export_tables}
    if members:
        table_payloads.update(members.get('tables', {}))

    manifest = {
        'format': 'ghosthub-user-data-export',
        'format_version': 1,
        'schema_version': schema_version,
        'ghosthub_version': VERSION,
        'exported_at': '2026-05-14T20:00:00Z',
        'drives': drives or [],
        'tables': {
            table: {'row_count': len(rows)}
            for table, rows in table_payloads.items()
        },
    }
    config = {
        'python_config': {'ADMIN_PASSWORD': 'restored'},
        'javascript_config': {'ui': {'theme': 'dark'}},
    }

    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as export_zip:
        export_zip.writestr('manifest.json', json.dumps(manifest))
        export_zip.writestr('ghosthub_config.json', json.dumps(config))
        if wifi_config is not None:
            export_zip.writestr('wifi_config.json', json.dumps(wifi_config))
        for table, member_name in TABLE_MEMBERS.items():
            export_zip.writestr(member_name, json.dumps(table_payloads[table]))


def _backup_path(drive_path, filename='ghosthub-user-data-20260514-130000.zip'):
    backup_dir = drive_path / 'GhostHubBackups'
    backup_dir.mkdir()
    return backup_dir / filename


class TestUserDataTransferService:
    def test_export_creates_exact_expected_zip_members(self, app_context, tmp_path):
        drive = register_test_storage_drive(tmp_path, writable=True, device_key='drive-export')

        from app.services.core import config_service
        from app.services.core.sqlite_runtime_service import get_db
        from app.services.system.user_data_transfer_service import ALLOWED_ZIP_MEMBERS

        config = config_service.get_default_config()
        config['javascript_config']['ui']['customThemes'] = [{
            'id': 'custom-sunset',
            'name': 'Custom Sunset',
            'colors': {'primary': '#ff8800'},
        }]
        config_service.save_config(config)

        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO profiles (
                    id, name, avatar_color, avatar_icon, preferences_json,
                    created_at, last_active_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    'profile-export',
                    'Export User',
                    '#111111',
                    'ghost',
                    '{"theme": "custom-sunset"}',
                    1,
                    2,
                ),
            )
            conn.execute(
                "INSERT INTO media_index (id, category_id, rel_path, parent_path, name, size, mtime, hash, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ('media-1', 'cat-1', 'v.mp4', '', 'v.mp4', 1, 1, 'hash', 'video', 1, 1),
            )
            conn.execute(
                "INSERT INTO schema_info (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                ('custom-test-key', 'do-not-export'),
            )

        job_id = _service().start_export(drive['id'])
        job = _service().get_job(job_id)

        assert job['status'] == 'complete'
        export_path = tmp_path / 'GhostHubBackups' / job['result']['filename']
        with zipfile.ZipFile(export_path, 'r') as export_zip:
            names = set(export_zip.namelist())
            manifest = json.loads(export_zip.read('manifest.json'))
            exported_config = json.loads(export_zip.read('ghosthub_config.json'))
            exported_wifi_config = json.loads(export_zip.read('wifi_config.json'))
            exported_profiles = json.loads(export_zip.read('tables/profiles.json'))

        assert names == set(ALLOWED_ZIP_MEMBERS)
        assert 'tables/media_index.json' not in names
        assert 'tables/file_path_aliases.json' not in names
        assert 'tables/schema_info.json' not in names
        assert manifest['schema_version'] == SCHEMA_VERSION
        assert manifest['ghosthub_version'] == VERSION
        assert manifest['drives'][0]['device_key'] == 'drive-export'
        assert manifest['tables']['profiles']['row_count'] == 1
        assert exported_config['javascript_config']['ui']['customThemes'][0]['id'] == 'custom-sunset'
        assert json.loads(exported_profiles[0]['preferences_json'])['theme'] == 'custom-sunset'
        assert exported_wifi_config['ssid']

    def test_export_normalizes_stale_custom_theme_color_keys(self, app_context, tmp_path):
        drive = register_test_storage_drive(tmp_path, writable=True, device_key='drive-theme-export')

        from app.services.core import config_service

        stale_config = config_service.get_default_config()
        stale_config['javascript_config']['ui']['theme'] = 'custom-stale'
        stale_config['javascript_config']['ui']['customThemes'] = [{
            'id': 'custom-stale',
            'name': 'Stale Theme',
            'colors': {
                'primary': '#112233',
                'secondary': '#445566',
                'accent': '#778899',
                'background': '#000000',
                'surface': '#111111',
                'text': '#ffffff',
            },
        }]
        stale_config['javascript_config']['ui']['customThemeColors'] = {
            'primary': '#112233',
            'secondary': '#445566',
            'accent': '#778899',
            'background': '#000000',
            'surface': '#111111',
            'text': '#ffffff',
        }

        os.makedirs(os.path.dirname(config_service.CONFIG_FILE_PATH), exist_ok=True)
        with open(config_service.CONFIG_FILE_PATH, 'w', encoding='utf-8') as config_file:
            json.dump(stale_config, config_file)

        job_id = _service().start_export(drive['id'])
        job = _service().get_job(job_id)

        assert job['status'] == 'complete'
        export_path = tmp_path / 'GhostHubBackups' / job['result']['filename']
        with zipfile.ZipFile(export_path, 'r') as export_zip:
            exported_config = json.loads(export_zip.read('ghosthub_config.json'))

        ui_config = exported_config['javascript_config']['ui']
        assert 'secondary' not in ui_config['customThemes'][0]['colors']
        assert 'secondary' not in ui_config['customThemeColors']

    def test_same_device_export_import_preserves_row_counts(self, app_context, tmp_path):
        drive = register_test_storage_drive(tmp_path, writable=True, device_key='drive-smoke')

        from app.services.core.sqlite_runtime_service import get_db

        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO profiles (
                    id, name, avatar_color, avatar_icon, preferences_json,
                    created_at, last_active_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    'profile-smoke',
                    'Smoke User',
                    '#123456',
                    'ghost',
                    '{"layout": "streaming"}',
                    1,
                    2,
                ),
            )
            conn.execute(
                """
                INSERT INTO categories (
                    id, name, path, is_manual, version_hash, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                ('cat-smoke', 'Smoke Movies', '/media/smoke', 1, 'hash', 1, 2),
            )
            conn.execute(
                """
                INSERT INTO video_progress (
                    video_path, profile_id, category_id, video_timestamp,
                    video_duration, thumbnail_url, last_watched, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ('/media/smoke/video.mp4', 'profile-smoke', 'cat-smoke', 10, 100, None, 20, 30),
            )

        export_job_id = _service().start_export(drive['id'])
        export_job = _service().get_job(export_job_id)

        assert export_job['status'] == 'complete'

        import_job_id = _service().start_import(drive['id'], export_job['result']['filename'])
        import_job = _service().get_job(import_job_id)

        assert import_job['status'] == 'complete'
        assert import_job['result']['rows_imported'] == export_job['result']['rows_exported']

    def test_invalid_drive_and_non_writable_drive_fail_jobs(self, app_context, tmp_path):
        drive = register_test_storage_drive(tmp_path, writable=False, device_key='drive-readonly')

        from app.services.system.user_data_transfer_service import UserDataTransferError

        with pytest.raises(UserDataTransferError) as missing_error:
            _service().start_export('missing-drive')
        with pytest.raises(UserDataTransferError) as readonly_error:
            _service().start_export(drive['id'])

        assert 'not available' in str(missing_error.value)
        assert 'not writable' in str(readonly_error.value)

    def test_zip_path_traversal_is_rejected_before_database_ready(
        self,
        app_context,
        tmp_path,
        monkeypatch,
    ):
        drive = register_test_storage_drive(tmp_path, writable=True, device_key='drive-traversal')
        export_path = _backup_path(tmp_path)

        with zipfile.ZipFile(export_path, 'w') as export_zip:
            export_zip.writestr('manifest.json', '{}')
            export_zip.writestr('../escape.json', '{}')

        def fail_if_called():
            raise AssertionError('database readiness should not run for invalid zip')

        monkeypatch.setattr(
            'app.services.system.user_data_transfer_service.ensure_database_ready',
            fail_if_called,
        )

        job_id = _service().start_import(drive['id'], export_path.name)
        job = _service().get_job(job_id)

        assert job['status'] == 'error'
        assert 'unsafe path' in job['error']

    def test_newer_schema_export_is_rejected(self, app_context, tmp_path):
        drive = register_test_storage_drive(tmp_path, writable=True, device_key='drive-schema-newer')
        export_path = _backup_path(tmp_path)
        _write_export_zip(export_path, schema_version=SCHEMA_VERSION + 1)

        job_id = _service().start_import(drive['id'], export_path.name)
        job = _service().get_job(job_id)

        assert job['status'] == 'error'
        assert 'newer than this device' in job['error']

    def test_older_schema_export_without_migration_path_is_rejected(self, app_context, tmp_path):
        drive = register_test_storage_drive(tmp_path, writable=True, device_key='drive-schema-old')
        export_path = _backup_path(tmp_path)
        _write_export_zip(
            export_path,
            schema_version=12,
            members={
                'tables': {
                    'profiles': [{
                        'id': 'old-profile',
                        'name': 'Old Export User',
                        'preferences_json': '{"layout": "gallery"}',
                        'created_at': 1,
                        'last_active_at': 2,
                    }],
                },
            },
        )

        job_id = _service().start_import(drive['id'], export_path.name)
        job = _service().get_job(job_id)

        assert job['status'] == 'error'
        assert f'expects {SCHEMA_VERSION}' in job['error']

    def test_import_upserts_and_maps_conflicting_profile_and_category(
        self,
        app_context,
        tmp_path,
    ):
        drive = register_test_storage_drive(tmp_path, writable=True, device_key='drive-import')
        export_path = _backup_path(tmp_path)

        from app.services.core.sqlite_runtime_service import get_db

        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO profiles (
                    id, name, avatar_color, avatar_icon, preferences_json,
                    created_at, last_active_at
                )
                VALUES (?, ?, NULL, NULL, NULL, ?, ?)
                """,
                ('local-profile', 'Alice', 1, 100),
            )
            conn.execute(
                """
                INSERT INTO categories (
                    id, name, path, is_manual, version_hash, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                ('local-cat', 'Movies', '/media/movies', 1, 'local', 1, 100),
            )
            conn.execute(
                """
                INSERT INTO video_progress (
                    video_path, profile_id, category_id, video_timestamp,
                    video_duration, thumbnail_url, last_watched, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ('/media/movies/existing.mp4', 'local-profile', 'local-cat', 90, 120, None, 100, 200),
            )

        _write_export_zip(
            export_path,
            members={
                'tables': {
                    'profiles': [{
                        'id': 'import-profile',
                        'name': 'Alice',
                        'avatar_color': '#abcdef',
                        'avatar_icon': 'star',
                        'preferences_json': '{"volume": 0.5}',
                        'created_at': 2,
                        'last_active_at': 150,
                    }],
                    'categories': [{
                        'id': 'import-cat',
                        'name': 'Movies Restored',
                        'path': '/media/movies',
                        'is_manual': 1,
                        'version_hash': 'imported',
                        'created_at': 2,
                        'updated_at': 150,
                    }],
                    'hidden_categories': [{
                        'category_id': 'import-cat',
                        'hidden_at': 20,
                        'hidden_by': 'admin',
                    }],
                    'hidden_files': [{
                        'file_path': '/media/movies/hidden.mp4',
                        'category_id': 'import-cat',
                        'hidden_at': 21,
                        'hidden_by': 'admin',
                    }],
                    'video_progress': [
                        {
                            'video_path': '/media/movies/existing.mp4',
                            'profile_id': 'import-profile',
                            'category_id': 'import-cat',
                            'video_timestamp': 10,
                            'video_duration': 120,
                            'thumbnail_url': None,
                            'last_watched': 10,
                            'updated_at': 50,
                        },
                        {
                            'video_path': '/media/movies/new.mp4',
                            'profile_id': 'import-profile',
                            'category_id': 'import-cat',
                            'video_timestamp': 15,
                            'video_duration': 120,
                            'thumbnail_url': None,
                            'last_watched': 150,
                            'updated_at': 250,
                        },
                    ],
                    'drive_labels': [{
                        'device_key': 'drive-key',
                        'label': 'Restored USB',
                        'updated_at': 10,
                    }],
                },
            },
        )

        job_id = _service().start_import(drive['id'], export_path.name)
        job = _service().get_job(job_id)

        assert job['status'] == 'complete'
        with get_db() as conn:
            profiles = conn.execute("SELECT id, name FROM profiles").fetchall()
            existing_progress = conn.execute(
                "SELECT video_timestamp, updated_at FROM video_progress WHERE video_path = ? AND profile_id = ?",
                ('/media/movies/existing.mp4', 'local-profile'),
            ).fetchone()
            new_progress = conn.execute(
                "SELECT profile_id, category_id, video_timestamp FROM video_progress WHERE video_path = ?",
                ('/media/movies/new.mp4',),
            ).fetchone()
            hidden_category = conn.execute(
                "SELECT category_id FROM hidden_categories WHERE category_id = ?",
                ('local-cat',),
            ).fetchone()
            hidden_file = conn.execute(
                "SELECT category_id FROM hidden_files WHERE file_path = ?",
                ('/media/movies/hidden.mp4',),
            ).fetchone()
            label = conn.execute(
                "SELECT label FROM drive_labels WHERE device_key = ?",
                ('drive-key',),
            ).fetchone()

        assert [(row['id'], row['name']) for row in profiles] == [('local-profile', 'Alice')]
        assert existing_progress['video_timestamp'] == 90
        assert existing_progress['updated_at'] == 200
        assert new_progress['profile_id'] == 'local-profile'
        assert new_progress['category_id'] == 'local-cat'
        assert new_progress['video_timestamp'] == 15
        assert hidden_category is not None
        assert hidden_file['category_id'] == 'local-cat'
        assert label['label'] == 'Restored USB'

    def test_import_remaps_renamed_usb_paths_by_device_key(
        self,
        app_context,
        tmp_path,
        monkeypatch,
    ):
        new_root = tmp_path / 'NEWUSB'
        new_root.mkdir()
        drive = register_test_storage_drive(new_root, name='NEWUSB', writable=True, device_key='stable-usb-key')
        export_path = _backup_path(new_root)
        old_root = tmp_path / 'OLDUSB'
        old_category_path = old_root / 'Movies'
        new_category_path = new_root / 'Movies'
        old_file_path = old_category_path / 'hidden.mp4'
        new_file_path = new_category_path / 'hidden.mp4'

        def fake_category_id(path):
            normalized = str(path).replace('\\', '/')
            if 'OLDUSB' in normalized:
                suffix = normalized.split('OLDUSB', 1)[1].strip('/')
                return 'auto::OLDUSB' + (f"::{suffix.replace('/', '::')}" if suffix else '')
            if 'NEWUSB' in normalized:
                suffix = normalized.split('NEWUSB', 1)[1].strip('/')
                return 'auto::NEWUSB' + (f"::{suffix.replace('/', '::')}" if suffix else '')
            return None

        monkeypatch.setattr(
            'app.services.storage.storage_path_service.get_category_id_from_path',
            fake_category_id,
        )

        _write_export_zip(
            export_path,
            drives=[{
                'device_key': 'stable-usb-key',
                'name': 'OLDUSB',
                'path': str(old_root),
                'label': 'Family Drive',
            }],
            members={
                'tables': {
                    'categories': [{
                        'id': 'auto::OLDUSB::Movies',
                        'name': 'Movies',
                        'path': str(old_category_path),
                        'is_manual': 0,
                        'version_hash': 'old',
                        'created_at': 1,
                        'updated_at': 2,
                    }],
                    'hidden_categories': [{
                        'category_id': 'auto::OLDUSB::Movies',
                        'hidden_at': 20,
                        'hidden_by': 'admin',
                    }],
                    'hidden_files': [{
                        'file_path': str(old_file_path),
                        'category_id': 'auto::OLDUSB::Movies',
                        'hidden_at': 21,
                        'hidden_by': 'admin',
                    }],
                    'video_progress': [{
                        'video_path': str(old_file_path),
                        'profile_id': 'profile-path-remap',
                        'category_id': 'auto::OLDUSB::Movies',
                        'video_timestamp': 10,
                        'video_duration': 120,
                        'thumbnail_url': None,
                        'last_watched': 10,
                        'updated_at': 50,
                    }],
                    'profiles': [{
                        'id': 'profile-path-remap',
                        'name': 'Path Remap User',
                        'avatar_color': '#abcdef',
                        'avatar_icon': 'star',
                        'preferences_json': '{}',
                        'created_at': 1,
                        'last_active_at': 2,
                    }],
                },
            },
        )

        job_id = _service().start_import(drive['id'], export_path.name)
        job = _service().get_job(job_id)

        assert job['status'] == 'complete'
        from app.services.core.sqlite_runtime_service import get_db

        with get_db() as conn:
            category = conn.execute(
                "SELECT id, path FROM categories WHERE id = ?",
                ('auto::NEWUSB::Movies',),
            ).fetchone()
            hidden_category = conn.execute(
                "SELECT category_id FROM hidden_categories WHERE category_id = ?",
                ('auto::NEWUSB::Movies',),
            ).fetchone()
            hidden_file = conn.execute(
                "SELECT file_path, category_id FROM hidden_files WHERE file_path = ?",
                (str(new_file_path),),
            ).fetchone()
            progress = conn.execute(
                "SELECT video_path, category_id FROM video_progress WHERE video_path = ?",
                (str(new_file_path),),
            ).fetchone()

        assert category['path'] == str(new_category_path)
        assert hidden_category is not None
        assert hidden_file['category_id'] == 'auto::NEWUSB::Movies'
        assert progress['category_id'] == 'auto::NEWUSB::Movies'

    def test_import_restores_wifi_config(self, app_context, tmp_path, monkeypatch):
        drive = register_test_storage_drive(tmp_path, writable=True, device_key='drive-wifi')
        export_path = _backup_path(tmp_path)
        restored_wifi = {
            'ssid': 'RestoredGhostHub',
            'password': 'restored-password',
            'channel': 11,
            'country_code': 'US',
        }
        saved = {}

        def fake_save_wifi_config(**kwargs):
            saved.update(kwargs)
            return True, 'saved'

        monkeypatch.setattr(
            'app.services.system.wifi.runtime_service.save_wifi_config',
            fake_save_wifi_config,
        )
        _write_export_zip(export_path, wifi_config=restored_wifi)

        job_id = _service().start_import(drive['id'], export_path.name)
        job = _service().get_job(job_id)

        assert job['status'] == 'complete'
        assert saved == restored_wifi

    def test_delete_rejects_non_export_zip(self, app_context, tmp_path):
        drive = register_test_storage_drive(tmp_path, writable=True, device_key='drive-delete')
        export_path = _backup_path(tmp_path)
        export_path.write_text('not a zip', encoding='utf-8')

        with pytest.raises(Exception) as exc_info:
            _service().delete_export(drive['id'], export_path.name)

        assert 'invalid' in str(exc_info.value).lower()
        assert export_path.exists()

    def test_finished_jobs_self_clean_after_retention(self, app_context, monkeypatch):
        service = _service()
        service._jobs.clear()

        scheduled = []
        monkeypatch.setattr(service, 'timeout', lambda cb, secs: scheduled.append((cb, secs)))

        completed_id = service._create_job('export')['id']
        service._complete_job(completed_id, {'message': 'done'})

        failed_id = service._create_job('import')['id']
        service._fail_job(failed_id, 'boom')

        assert completed_id in service._jobs
        assert failed_id in service._jobs
        assert [secs for _cb, secs in scheduled] == [60, 60]

        for cb, _secs in scheduled:
            cb()

        assert completed_id not in service._jobs
        assert failed_id not in service._jobs
