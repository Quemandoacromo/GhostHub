"""
Tests for Config Service
-------------------------
Tests for configuration loading and saving, including:
- Default config generation
- Config file loading with merging
- Preservation of user-defined custom keys (customThemes, customThemeColors)
- Config saving
"""
import pytest
import json
import os
import tempfile
from unittest.mock import patch, MagicMock


class TestConfigServiceLoadConfig:
    """Tests for config loading functionality."""
    
    def test_load_config_returns_defaults_when_file_not_exists(self, app_context, tmp_path):
        """Test that load_config returns defaults when config file doesn't exist."""
        from app.services import config_service
        
        # Use a non-existent path
        original_path = config_service.CONFIG_FILE_PATH
        config_service.CONFIG_FILE_PATH = str(tmp_path / 'nonexistent.json')
        
        try:
            config, error = config_service.load_config()
            
            assert error is None
            assert 'python_config' in config
            assert 'javascript_config' in config
            assert config['javascript_config']['ui']['theme'] == 'dark'
        finally:
            config_service.CONFIG_FILE_PATH = original_path
    
    def test_load_config_merges_with_defaults(self, app_context, tmp_path):
        """Test that load_config merges loaded config with defaults."""
        from app.services import config_service
        
        # Create a partial config file
        config_file = tmp_path / 'ghosthub_config.json'
        partial_config = {
            "python_config": {
                "CACHE_EXPIRY": 600  # Different from default 300
            },
            "javascript_config": {
                "ui": {
                    "theme": "monokai"  # Different from default 'dark'
                }
            }
        }
        config_file.write_text(json.dumps(partial_config))
        
        original_path = config_service.CONFIG_FILE_PATH
        config_service.CONFIG_FILE_PATH = str(config_file)
        
        try:
            config, error = config_service.load_config()
            
            assert error is None
            # User value should be preserved
            assert config['python_config']['CACHE_EXPIRY'] == 600
            assert config['javascript_config']['ui']['theme'] == 'monokai'
            # Default values should be filled in
            assert 'DEFAULT_PAGE_SIZE' in config['python_config']
            assert 'layout' in config['javascript_config']['ui']
        finally:
            config_service.CONFIG_FILE_PATH = original_path
    
    def test_load_config_preserves_custom_themes(self, app_context, tmp_path):
        """Test that load_config preserves customThemes array (not in defaults)."""
        from app.services import config_service
        
        # Create config with customThemes
        config_file = tmp_path / 'ghosthub_config.json'
        config_with_custom = {
            "python_config": {},
            "javascript_config": {
                "ui": {
                    "theme": "custom-123456",
                    "customThemes": [
                        {
                            "id": "custom-123456",
                            "name": "My Theme",
                            "colors": {
                                "primary": "#ff0000",
                                "secondary": "#00ff00",
                                "accent": "#0000ff",
                                "background": "#121212",
                                "surface": "#1e1e1e",
                                "text": "#ffffff"
                            }
                        }
                    ],
                    "customThemeColors": {
                        "primary": "#ff0000",
                        "secondary": "#00ff00",
                        "accent": "#0000ff",
                        "background": "#121212",
                        "surface": "#1e1e1e",
                        "text": "#ffffff"
                    }
                }
            }
        }
        config_file.write_text(json.dumps(config_with_custom))
        
        original_path = config_service.CONFIG_FILE_PATH
        config_service.CONFIG_FILE_PATH = str(config_file)
        
        try:
            config, error = config_service.load_config()
            
            assert error is None
            ui_config = config['javascript_config']['ui']
            
            # Custom theme ID should be preserved
            assert ui_config['theme'] == 'custom-123456'
            
            # customThemes array should be preserved (this was the bug!)
            assert 'customThemes' in ui_config
            assert len(ui_config['customThemes']) == 1
            assert ui_config['customThemes'][0]['id'] == 'custom-123456'
            assert ui_config['customThemes'][0]['name'] == 'My Theme'
            assert 'secondary' not in ui_config['customThemes'][0]['colors']
            
            # customThemeColors should be preserved
            assert 'customThemeColors' in ui_config
            assert ui_config['customThemeColors']['primary'] == '#ff0000'
            assert 'secondary' not in ui_config['customThemeColors']
        finally:
            config_service.CONFIG_FILE_PATH = original_path
    
    def test_load_config_preserves_multiple_custom_themes(self, app_context, tmp_path):
        """Test that multiple custom themes are all preserved."""
        from app.services import config_service
        
        config_file = tmp_path / 'ghosthub_config.json'
        config_with_themes = {
            "python_config": {},
            "javascript_config": {
                "ui": {
                    "theme": "dark",
                    "customThemes": [
                        {"id": "custom-1", "name": "Theme 1", "colors": {"primary": "#111"}},
                        {"id": "custom-2", "name": "Theme 2", "colors": {"primary": "#222"}},
                        {"id": "custom-3", "name": "Theme 3", "colors": {"primary": "#333"}}
                    ]
                }
            }
        }
        config_file.write_text(json.dumps(config_with_themes))
        
        original_path = config_service.CONFIG_FILE_PATH
        config_service.CONFIG_FILE_PATH = str(config_file)
        
        try:
            config, error = config_service.load_config()
            
            assert error is None
            assert len(config['javascript_config']['ui']['customThemes']) == 3
        finally:
            config_service.CONFIG_FILE_PATH = original_path
    
    def test_load_config_handles_invalid_json(self, app_context, tmp_path):
        """Test that load_config handles invalid JSON gracefully."""
        from app.services import config_service
        
        config_file = tmp_path / 'ghosthub_config.json'
        config_file.write_text('{ invalid json }')
        
        original_path = config_service.CONFIG_FILE_PATH
        config_service.CONFIG_FILE_PATH = str(config_file)
        
        try:
            config, error = config_service.load_config()
            
            # Should return defaults with an error message
            assert error is not None
            assert 'python_config' in config
            assert 'javascript_config' in config
        finally:
            config_service.CONFIG_FILE_PATH = original_path

    def test_load_config_hardware_scaling_pro(self, app_context, tmp_path):
        """Test that MAX_CACHE_SIZE is scaled up for PRO tier."""
        from app.services import config_service
        
        config_file = tmp_path / 'ghosthub_config.json'
        # Partial config with default cache size
        partial_config = {
            "python_config": {
                "AUTO_OPTIMIZE_FOR_HARDWARE": True,
                "MAX_CACHE_SIZE": 50
            },
            "javascript_config": {}
        }
        config_file.write_text(json.dumps(partial_config))
        
        original_path = config_service.CONFIG_FILE_PATH
        config_service.CONFIG_FILE_PATH = str(config_file)
        
        try:
            with patch('app.services.system.system_stats_service.get_hardware_tier', return_value='PRO'):
                config, error = config_service.load_config()
                assert error is None
                # Should be scaled to 500
                assert config['python_config']['MAX_CACHE_SIZE'] == 500
        finally:
            config_service.CONFIG_FILE_PATH = original_path

    def test_load_config_hardware_scaling_standard(self, app_context, tmp_path):
        """Test that MAX_CACHE_SIZE is scaled up for STANDARD tier."""
        from app.services import config_service
        
        config_file = tmp_path / 'ghosthub_config.json'
        partial_config = {
            "python_config": {
                "AUTO_OPTIMIZE_FOR_HARDWARE": True,
                "MAX_CACHE_SIZE": 50
            },
            "javascript_config": {}
        }
        config_file.write_text(json.dumps(partial_config))
        
        original_path = config_service.CONFIG_FILE_PATH
        config_service.CONFIG_FILE_PATH = str(config_file)
        
        try:
            with patch('app.services.system.system_stats_service.get_hardware_tier', return_value='STANDARD'):
                config, error = config_service.load_config()
                assert error is None
                # Should be scaled to 200
                assert config['python_config']['MAX_CACHE_SIZE'] == 200
        finally:
            config_service.CONFIG_FILE_PATH = original_path

    def test_load_config_hardware_scaling_disabled(self, app_context, tmp_path):
        """Test that hardware scaling is not applied when disabled."""
        from app.services import config_service
        
        config_file = tmp_path / 'ghosthub_config.json'
        partial_config = {
            "python_config": {
                "AUTO_OPTIMIZE_FOR_HARDWARE": False,
                "MAX_CACHE_SIZE": 50
            },
            "javascript_config": {}
        }
        config_file.write_text(json.dumps(partial_config))
        
        original_path = config_service.CONFIG_FILE_PATH
        config_service.CONFIG_FILE_PATH = str(config_file)
        
        try:
            with patch('app.services.system.system_stats_service.get_hardware_tier', return_value='PRO'):
                config, error = config_service.load_config()
                assert error is None
                # Should remain 50
                assert config['python_config']['MAX_CACHE_SIZE'] == 50
        finally:
            config_service.CONFIG_FILE_PATH = original_path


class TestConfigServiceSaveConfig:
    """Tests for config saving functionality."""
    
    def test_save_config_writes_file(self, app_context, tmp_path):
        """Test that save_config writes the config file."""
        from app.services import config_service
        
        config_file = tmp_path / 'instance' / 'ghosthub_config.json'
        original_path = config_service.CONFIG_FILE_PATH
        original_instance = config_service._instance_folder
        
        config_service._instance_folder = str(tmp_path / 'instance')
        config_service.CONFIG_FILE_PATH = str(config_file)
        
        try:
            test_config = {
                "python_config": {"TEST_KEY": "test_value"},
                "javascript_config": {"ui": {"theme": "nord"}}
            }
            
            success, message = config_service.save_config(test_config)
            
            assert success is True
            assert config_file.exists()
            
            # Verify contents
            saved = json.loads(config_file.read_text())
            assert saved['python_config']['TEST_KEY'] == 'test_value'
            assert saved['javascript_config']['ui']['theme'] == 'nord'
        finally:
            config_service.CONFIG_FILE_PATH = original_path
            config_service._instance_folder = original_instance
    
    def test_save_config_preserves_custom_themes(self, app_context, tmp_path):
        """Test that save_config preserves customThemes in the saved file."""
        from app.services import config_service
        
        config_file = tmp_path / 'instance' / 'ghosthub_config.json'
        original_path = config_service.CONFIG_FILE_PATH
        original_instance = config_service._instance_folder
        
        config_service._instance_folder = str(tmp_path / 'instance')
        config_service.CONFIG_FILE_PATH = str(config_file)
        
        try:
            test_config = {
                "python_config": {},
                "javascript_config": {
                    "ui": {
                        "theme": "custom-999",
                        "customThemes": [
                            {"id": "custom-999", "name": "Saved Theme", "colors": {"primary": "#abc"}}
                        ],
                        "customThemeColors": {"primary": "#abc"}
                    }
                }
            }
            
            success, message = config_service.save_config(test_config)
            assert success is True
            
            # Load it back and verify
            config, error = config_service.load_config()
            assert error is None
            assert config['javascript_config']['ui']['customThemes'][0]['name'] == 'Saved Theme'
            assert 'secondary' not in config['javascript_config']['ui']['customThemes'][0]['colors']
        finally:
            config_service.CONFIG_FILE_PATH = original_path
            config_service._instance_folder = original_instance
    
    def test_save_config_rejects_invalid_structure(self, app_context, tmp_path):
        """Test that save_config rejects configs without required sections."""
        from app.services import config_service
        
        # Missing python_config
        success, message = config_service.save_config({"javascript_config": {}})
        assert success is False
        
        # Missing javascript_config
        success, message = config_service.save_config({"python_config": {}})
        assert success is False
        
        # Empty/None config
        success, message = config_service.save_config(None)
        assert success is False


class TestConfigServiceRoundTrip:
    """Tests for save-then-load round trips."""
    
    def test_custom_themes_survive_round_trip(self, app_context, tmp_path):
        """Test that custom themes survive a save-load round trip."""
        from app.services import config_service
        
        config_file = tmp_path / 'instance' / 'ghosthub_config.json'
        original_path = config_service.CONFIG_FILE_PATH
        original_instance = config_service._instance_folder
        
        config_service._instance_folder = str(tmp_path / 'instance')
        config_service.CONFIG_FILE_PATH = str(config_file)
        
        try:
            # Create config with custom theme
            original_config = {
                "python_config": {"CACHE_EXPIRY": 300},
                "javascript_config": {
                    "ui": {
                        "theme": "custom-roundtrip",
                        "layout": "streaming",
                        "features": {"chat": True},
                        "customThemes": [
                            {
                                "id": "custom-roundtrip",
                                "name": "Round Trip Theme",
                                "colors": {
                                    "primary": "#123456",
                                    "secondary": "#654321",
                                    "accent": "#abcdef",
                                    "background": "#000000",
                                    "surface": "#111111",
                                    "text": "#ffffff"
                                },
                                "createdAt": "2024-01-01T00:00:00Z"
                            }
                        ],
                        "customThemeColors": {
                            "primary": "#123456",
                            "secondary": "#654321",
                            "accent": "#abcdef",
                            "background": "#000000",
                            "surface": "#111111",
                            "text": "#ffffff"
                        }
                    },
                    "main": {},
                    "core_app": {},
                    "sync_manager": {}
                }
            }
            
            # Save
            success, _ = config_service.save_config(original_config)
            assert success is True
            
            # Load
            loaded_config, error = config_service.load_config()
            assert error is None
            
            # Verify custom data survived
            ui = loaded_config['javascript_config']['ui']
            assert ui['theme'] == 'custom-roundtrip'
            assert len(ui['customThemes']) == 1
            assert ui['customThemes'][0]['id'] == 'custom-roundtrip'
            assert ui['customThemes'][0]['name'] == 'Round Trip Theme'
            assert ui['customThemes'][0]['colors']['primary'] == '#123456'
            assert 'secondary' not in ui['customThemes'][0]['colors']
            assert ui['customThemeColors']['primary'] == '#123456'
            assert 'secondary' not in ui['customThemeColors']
        finally:
            config_service.CONFIG_FILE_PATH = original_path
            config_service._instance_folder = original_instance
