/**
 * User Preferences Section
 * Allows users to set their personal theme, layout, and UI toggles.
 * Stored in localStorage, separate from server defaults.
 */

import { dropletIcon, userIcon, editIcon, trashIcon } from '../../../utils/icons.js';
import { setupCollapsibleSection } from './sectionUtils.js';
import { getUserPreferences, saveUserPreference, getUserPreference } from '../../../utils/userPreferences.js';
import {
    applyProfileAvatar,
    createProfileAvatar,
    createProfileAvatarPicker,
    getDefaultProfileAvatarColor,
} from '../../../utils/profileAvatarLibrary.js';
import {
    AVAILABLE_LAYOUTS,
    getAvailableThemes,
    applyTheme,
    applyLayout,
    applyFeatureToggles
} from '../../../utils/themeManager.js';
import { openThemeBuilder } from '../themeBuilder.js';
import { Module, createElement, clear, append, $ } from '../../../libs/ragot.esm.min.js';
import { APP_EVENTS } from '../../../core/appEvents.js';
import { isUserAdmin } from '../../../utils/progressDB.js';
import { toast, dialog } from '../../../utils/notificationManager.js';
import { applyMotionPreference } from '../../../utils/motionPreferences.js';
import { ensureFeatureAccess } from '../../../utils/authManager.js';
import {
    PROFILE_SELECTED_EVENT,
    PROFILES_CHANGED_EVENT,
} from '../../profile/events.js';
import {
    formatProfileTimestamp,
    hasActiveProfile,
    validateProfileName,
} from '../../../utils/profileUtils.js';

async function fetchProfilePreferencesData() {
    const profilesResponse = await fetch('/api/profiles', { cache: 'no-store' });
    if (!profilesResponse.ok) {
        throw new Error(`Failed to load profiles (${profilesResponse.status})`);
    }

    const profilesData = await profilesResponse.json();
    return {
        profiles: Array.isArray(profilesData.profiles) ? profilesData.profiles : [],
        activeProfile: profilesData.active_profile || null,
    };
}

function getActiveProfileRecord(profileData) {
    if (!profileData?.activeProfile?.id) {
        return null;
    }

    return (
        profileData.profiles.find((profile) => profile.id === profileData.activeProfile.id) ||
        profileData.activeProfile
    );
}

function getAvailableOptionValue(options, preferredValue, fallbackValue) {
    const values = new Set(options.map(option => option.id));
    if (values.has(preferredValue)) return preferredValue;
    if (values.has(fallbackValue)) return fallbackValue;
    return options[0]?.id || '';
}

function getAppliedThemeId() {
    const theme = document.documentElement.getAttribute('data-theme');
    return theme && theme !== 'custom' ? theme : 'dark';
}

/**
 * Creates the user preferences section.
 * @param {Function} closeConfigModal - Callback to close the config modal
 * @returns {DocumentFragment} The section fragment to append
 */
export function createUserPreferencesSection(closeConfigModal) {
    const fragment = document.createDocumentFragment();
    let themeChangedHandler = null;
    const lifecycle = new Module().start();
    let profileRoot = null;
    let profileData = { profiles: [], activeProfile: null };
    let editingProfileId = null;
    let themeSelect = null;
    let layoutSelect = null;
    let motionSelect = null;
    const featureCheckboxes = {};

    async function openProfileChooser() {
        const selector = window.ragotModules?.profileSelector || null;
        if (!selector) {
            toast.error('Profile selector is not available right now.');
            return;
        }

        try {
            selector.open({ required: false, loading: true });
            closeConfigModal();
            try {
                await selector.refreshProfiles();
            } catch (error) {
                toast.error(error.message || 'Failed to load profiles.');
            }
        } catch (error) {
            toast.error(error.message || 'Failed to load profiles.');
        }
    }

    function renderProfileEditor(profile) {
        let selectedAvatarIcon = profile.avatar_icon || null;
        const defaultColor = profile.avatar_color || getDefaultProfileAvatarColor();
        const previewAvatar = createProfileAvatar({
            name: profile.name || '',
            avatar_color: defaultColor,
            avatar_icon: selectedAvatarIcon,
        }, 'gh-profile-avatar--lg', {
            initialsFallback: 'AZ',
        });
        const form = createElement('form', {
            className: 'gh-profile-inline-editor gh-profile-create-form gh-profile-inline-editor--expanded',
            onSubmit: async (event) => {
                event.preventDefault();

                const accessGranted = await ensureFeatureAccess();
                if (!accessGranted) {
                    return;
                }

                const nameInput = $('.gh-profile-inline-editor__name', form);
                const colorInput = $('.gh-profile-inline-editor__color', form);
                const nextName = nameInput?.value?.trim() || '';
                const nextColor = colorInput?.value || null;
                const validationError = validateProfileName(nextName);

                if (validationError) {
                    toast.error(validationError);
                    return;
                }

                const response = await fetch(`/api/profiles/${profile.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: nextName,
                        avatar_color: nextColor,
                        avatar_icon: selectedAvatarIcon,
                    })
                });
                const data = await response.json().catch(() => ({}));

                if (!response.ok || !data.profile) {
                    toast.error(data.error || data.message || 'Failed to update profile.');
                    return;
                }

                editingProfileId = null;
                toast.success(`Updated ${data.profile.name}.`);
                await refreshProfileSection();
            }
        });

        const updateRowAvatar = () => {
            applyProfileAvatar(previewAvatar, {
                name: nameInput?.value || profile.name || '',
                avatar_color: colorInput?.value || defaultColor,
                avatar_icon: selectedAvatarIcon,
            }, {
                initialsFallback: 'AZ',
            });

            const row = form.closest('.gh-profile-admin-row');
            const avatar = row?.querySelector('.gh-profile-avatar');
            if (!avatar) {
                return;
            }

            applyProfileAvatar(avatar, {
                name: nameInput?.value || profile.name || '',
                avatar_color: colorInput?.value || defaultColor,
                avatar_icon: selectedAvatarIcon,
            });
        };

        const nameInput = createElement('input', {
            type: 'text',
            className: 'gh-input gh-profile-inline-editor__name gh-profile-create-form__name',
            value: profile.name,
            maxLength: 24,
            onInput: () => {
                updateRowAvatar();
                avatarPicker.refresh();
            }
        });

        const colorInput = createElement('input', {
            type: 'color',
            className: 'gh-profile-inline-editor__color gh-profile-create-form__color',
            value: defaultColor,
            onInput: () => {
                updateRowAvatar();
                avatarPicker.refresh();
            }
        });

        const avatarPicker = createProfileAvatarPicker({
            getName: () => nameInput.value || '',
            getColor: () => colorInput.value || defaultColor,
            initialIcon: selectedAvatarIcon,
            onChange: (nextIcon) => {
                selectedAvatarIcon = nextIcon;
                updateRowAvatar();
            },
        });

        append(form,
            createElement('div', { className: 'gh-profile-create-form__fields gh-profile-inline-editor__fields' },
                previewAvatar,
                nameInput,
                createElement('label', {
                    className: 'gh-profile-inline-editor__swatch gh-profile-create-form__swatch'
                },
                    createElement('span', {
                        className: 'gh-profile-inline-editor__label gh-profile-create-form__swatch-label',
                        textContent: 'Color'
                    }),
                    colorInput
                ),
                createElement('div', { className: 'gh-profile-inline-editor__actions' },
                    createElement('button', {
                        type: 'submit',
                        className: 'btn btn--primary btn--sm',
                        textContent: 'Save'
                    }),
                    createElement('button', {
                        type: 'button',
                        className: 'btn btn--secondary btn--sm',
                        textContent: 'Cancel',
                        onClick: () => {
                            editingProfileId = null;
                            renderProfileSection();
                        }
                    })
                )
            ),
            avatarPicker.element,
        );

        return form;
    }

    function renderCurrentProfileRow(profile) {
        const headerRow = createElement('div', { className: 'gh-profile-admin-row__header' },
            createElement('div', { className: 'gh-profile-admin-row__identity' },
                createProfileAvatar(profile),
                createElement('div', { className: 'gh-profile-admin-row__meta' },
                    createElement('div', { className: 'gh-profile-admin-row__title' },
                        createElement('span', { textContent: profile.name }),
                        createElement('span', {
                            className: 'gh-profile-admin-row__badge',
                            textContent: 'Current'
                        })
                    ),
                    createElement('div', {
                        className: 'gh-profile-admin-row__submeta',
                        textContent: `Last active ${formatProfileTimestamp(profile.last_active_at)}`
                    })
                )
            ),
            createElement('div', { className: 'gh-profile-admin-row__actions' },
                createElement('button', {
                    type: 'button',
                    className: 'btn btn--secondary btn--sm',
                    innerHTML: editIcon(16),
                    title: `Edit ${profile.name}`,
                    onClick: () => {
                        editingProfileId = editingProfileId === profile.id ? null : profile.id;
                        renderProfileSection();
                    }
                }),
                createElement('button', {
                    type: 'button',
                    className: 'btn btn--danger btn--sm',
                    innerHTML: trashIcon(16),
                    title: `Delete ${profile.name}`,
                    onClick: async () => {
                        const accessGranted = await ensureFeatureAccess();
                        if (!accessGranted) {
                            return;
                        }

                        const confirmed = await dialog.confirm(
                            `Delete "${profile.name}"?\n\nThis also removes all saved progress for that profile.`,
                            { type: 'danger' }
                        );
                        if (!confirmed) {
                            return;
                        }

                        const response = await fetch(`/api/profiles/${profile.id}`, {
                            method: 'DELETE'
                        });
                        const data = await response.json().catch(() => ({}));

                        if (!response.ok) {
                            toast.error(data.error || data.message || 'Failed to delete profile.');
                            return;
                        }

                        editingProfileId = null;
                        toast.success(`Deleted ${profile.name}.`);
                        await refreshProfileSection();
                    }
                })
            )
        );

        return createElement('div', { className: 'gh-profile-admin-list' },
            createElement('div', { className: 'gh-profile-admin-row' },
                headerRow,
                editingProfileId === profile.id
                    ? createElement('div', { className: 'gh-profile-admin-row__editor' }, renderProfileEditor(profile))
                    : null
            )
        );
    }

    function renderProfileSection() {
        if (!profileRoot) {
            return;
        }

        clear(profileRoot);

        const currentProfile = getActiveProfileRecord(profileData);
        append(profileRoot,
            createElement('div', { className: 'form-group form-group-separator gh-profile-preferences' },
                createElement('label', { textContent: 'Profiles' }),
                createElement('div', {
                    className: 'config-description',
                    textContent: 'Switch profiles for this session. Edit or delete the currently selected profile here.'
                }),
                createElement('button', {
                    type: 'button',
                    className: 'btn btn--primary btn--full gh-profile-switch-btn',
                    textContent: 'Switch Profile',
                    onClick: () => openProfileChooser()
                }),
                currentProfile
                    ? renderCurrentProfileRow(currentProfile)
                    : createElement('p', {
                        className: 'admin-users-state',
                        textContent: profileData.profiles.length > 0
                            ? 'No profile selected. Use Switch Profile, then edit or delete the selected profile here.'
                            : 'No profiles yet. Use Switch Profile to create one or continue without a profile.'
                    })
            )
        );
    }

    async function refreshProfileSection() {
        if (!profileRoot) {
            return;
        }

        clear(profileRoot);
        append(profileRoot, createElement('p', {
            className: 'admin-users-state',
            textContent: 'Loading profiles...'
        }));

        try {
            profileData = await fetchProfilePreferencesData();
            renderProfileSection();
        } catch (error) {
            clear(profileRoot);
            append(profileRoot, createElement('p', {
                className: 'admin-users-state admin-users-state--error',
                textContent: error.message || 'Failed to load profiles.'
            }));
        }
    }

    // Unified card wrapper
    const card = createElement('div', { className: 'card card--config' });

    // Collapsible header
    const header = createElement('div', {
        className: 'card__header',
        innerHTML: `${userIcon(16)} My Preferences`,
    });
    card.appendChild(header);

    const container = createElement('div', { className: 'card__body' });
    card.appendChild(container);

    setupCollapsibleSection(header, container);

    fragment.appendChild(card);

    // Get server defaults for fallback
    const runtimeConfig = window.ragotModules?.appStore?.get?.('config', {}) || {};
    const serverTheme = runtimeConfig?.javascript_config?.ui?.theme || getAppliedThemeId();
    const serverLayout = runtimeConfig?.javascript_config?.ui?.layout || 'streaming';
    const serverFeatures = runtimeConfig?.javascript_config?.ui?.features || {};

    function syncPreferenceControls() {
        if (themeSelect) {
            const themes = getAvailableThemes();
            themeSelect.value = getAvailableOptionValue(
                themes,
                getUserPreference('theme', serverTheme),
                getAppliedThemeId()
            );
        }

        if (layoutSelect) {
            layoutSelect.value = getAvailableOptionValue(
                AVAILABLE_LAYOUTS,
                getUserPreference('layout', serverLayout),
                'streaming'
            );
        }

        if (motionSelect) {
            motionSelect.value = getUserPreference('motion', null) || 'system';
        }

        Object.entries(featureCheckboxes).forEach(([key, checkbox]) => {
            if (!checkbox) return;
            checkbox.checked = getUserPreference(`features.${key}`, serverFeatures[key]) !== false;
        });
    }

    // Info message
    const infoDiv = createElement('div', { className: 'config-description' });

    const isAdmin = isUserAdmin();
    if (isAdmin) {
        infoDiv.innerHTML = '<strong>Your Preferences:</strong> These are saved to the selected profile. If no profile is selected, they stay on this browser only. Use Server Settings below to change defaults for everyone.';
    } else {
        infoDiv.innerHTML = '<strong>Your Preferences:</strong> Customize your theme, layout, and UI. These settings save to the selected profile, or to this browser when no profile is selected.';
    }
    container.appendChild(infoDiv);

    profileRoot = createElement('div', { id: 'preferences-profile-section' });
    container.appendChild(profileRoot);
    refreshProfileSection();
    lifecycle.on(window, PROFILE_SELECTED_EVENT, () => {
        refreshProfileSection();
        syncPreferenceControls();
    });
    lifecycle.on(window, PROFILES_CHANGED_EVENT, () => refreshProfileSection());

    // Theme selector
    const themeGroup = createElement('div', { className: 'form-group' });
    themeGroup.appendChild(createElement('label', { textContent: 'Theme', htmlFor: 'user-pref-theme' }));

    themeSelect = createElement('select', {
        id: 'user-pref-theme',
        className: 'config-input-select',
    });

    const themes = getAvailableThemes();
    const currentTheme = getAvailableOptionValue(
        themes,
        getUserPreference('theme', serverTheme),
        getAppliedThemeId()
    );
    themes.forEach(theme => {
        const opt = createElement('option', { value: theme.id, textContent: theme.name });
        if (theme.id === currentTheme) opt.selected = true;
        themeSelect.appendChild(opt);
    });
    themeSelect.value = currentTheme;

    lifecycle.on(themeSelect, 'change', async () => {
        const newTheme = themeSelect.value;
        const previousTheme = getUserPreference('theme', serverTheme);
        applyTheme(newTheme, false);
        try {
            await saveUserPreference('theme', newTheme);
        } catch (error) {
            themeSelect.value = previousTheme;
            applyTheme(previousTheme, false);
            toast.error(error.message || 'Failed to save theme preference.');
            return;
        }
        console.log(`User theme changed to: ${newTheme}`);
    });

    themeGroup.appendChild(themeSelect);
    container.appendChild(themeGroup);

    // Listen for external theme changes (e.g. from Theme Builder)
    themeChangedHandler = (payload) => {
        if (payload?.theme && themeSelect.value !== payload.theme) {
            console.log(`Updating theme selector to: ${payload.theme}`);
            const exists = Array.from(themeSelect.options).some(opt => opt.value === payload.theme);
            if (!exists) {
                themeSelect.innerHTML = '';
                getAvailableThemes().forEach(theme => {
                    themeSelect.appendChild(createElement('option', { value: theme.id, textContent: theme.name }));
                });
            }
            themeSelect.value = getAvailableOptionValue(
                getAvailableThemes(),
                payload.theme,
                getAppliedThemeId()
            );
        }
    };
    lifecycle.listen(APP_EVENTS.THEME_CHANGED, themeChangedHandler);

    // Custom Theme Builder Button
    const customThemeGroup = createElement('div', { className: 'form-group' });

    const customThemeBtn = createElement('button', {
        className: 'btn btn--primary btn--full',
        type: 'button',
        innerHTML: dropletIcon(16) + ' Create Custom Theme',
    });
    lifecycle.on(customThemeBtn, 'click', () => {
        closeConfigModal({ afterClose: openThemeBuilder, restoreFocus: false });
    });

    const customThemeDesc = createElement('div', {
        className: 'config-description',
        textContent: 'Design your own color palette with live preview. Inspired by Realtime Colors.',
    });

    customThemeGroup.appendChild(customThemeBtn);
    customThemeGroup.appendChild(customThemeDesc);
    container.appendChild(customThemeGroup);

    // Layout selector
    const layoutGroup = createElement('div', { className: 'form-group' });
    layoutGroup.appendChild(createElement('label', { textContent: 'Layout', htmlFor: 'user-pref-layout' }));

    layoutSelect = createElement('select', {
        id: 'user-pref-layout',
        className: 'config-input-select',
    });

    const layouts = AVAILABLE_LAYOUTS || [
        { id: 'streaming', name: 'Streaming' },
        { id: 'gallery', name: 'Gallery' }
    ];

    layouts.forEach(layout => {
        layoutSelect.appendChild(createElement('option', { value: layout.id, textContent: layout.name }));
    });

    const currentLayout = getAvailableOptionValue(
        AVAILABLE_LAYOUTS,
        getUserPreference('layout', serverLayout),
        'streaming'
    );
    layoutSelect.value = currentLayout;

    lifecycle.on(layoutSelect, 'change', async () => {
        const newLayout = layoutSelect.value;
        const previousLayout = getUserPreference('layout', serverLayout);
        applyLayout(newLayout, false);
        try {
            await saveUserPreference('layout', newLayout);
        } catch (error) {
            layoutSelect.value = previousLayout;
            applyLayout(previousLayout, false);
            toast.error(error.message || 'Failed to save layout preference.');
            return;
        }
        console.log(`User layout changed to: ${newLayout}`);
    });

    layoutGroup.appendChild(layoutSelect);
    container.appendChild(layoutGroup);

    const motionGroup = createElement('div', { className: 'form-group' });
    motionGroup.appendChild(createElement('label', {
        textContent: 'Motion',
        htmlFor: 'user-pref-motion'
    }));

    motionSelect = createElement('select', {
        id: 'user-pref-motion',
        className: 'config-input-select',
    });
    [
        { value: 'system', label: 'Match Device Preference' },
        { value: 'reduced', label: 'Reduce Motion' }
    ].forEach(option => {
        motionSelect.appendChild(createElement('option', {
            value: option.value,
            textContent: option.label
        }));
    });

    const currentMotion = getUserPreference('motion', null) || 'system';
    motionSelect.value = currentMotion;

    lifecycle.on(motionSelect, 'change', async () => {
        const nextMotion = motionSelect.value === 'system' ? null : motionSelect.value;
        const previousMotion = getUserPreference('motion', null);
        applyMotionPreference(nextMotion);
        try {
            await saveUserPreference('motion', nextMotion);
        } catch (error) {
            motionSelect.value = previousMotion || 'system';
            applyMotionPreference(previousMotion);
            toast.error(error.message || 'Failed to save motion preference.');
            return;
        }
        console.log(`User motion preference changed to: ${nextMotion || 'system'}`);
    });

    motionGroup.appendChild(motionSelect);
    motionGroup.appendChild(createElement('div', {
        className: 'config-description',
        textContent: 'Reduce animation and transition movement throughout GhostHub.'
    }));
    container.appendChild(motionGroup);

    // Feature toggles
    const featureToggles = [
        { key: 'chat', label: 'Enable Chat' },
        { key: 'headerBranding', label: 'Show Header Branding' },
        { key: 'search', label: 'Enable Search Bar' },
        { key: 'syncButton', label: 'Show Sync Button' }
    ];

    featureToggles.forEach(({ key, label }) => {
        const featureGroup = createElement('div', { className: 'config-feature-row' });

        const checkbox = createElement('input', {
            type: 'checkbox',
            id: `user-pref-feature-${key}`,
            className: 'config-input-checkbox',
        });
        featureCheckboxes[key] = checkbox;

        const userPrefValue = getUserPreference(`features.${key}`, serverFeatures[key]);
        checkbox.checked = userPrefValue !== false;

        lifecycle.on(checkbox, 'change', async () => {
            const newValue = checkbox.checked;
            const previousValue = getUserPreference(`features.${key}`, serverFeatures[key]);

            const features = {};
            ['chat', 'headerBranding', 'search', 'syncButton'].forEach(featureKey => {
                features[featureKey] = featureKey === key
                    ? newValue
                    : getUserPreference(`features.${featureKey}`, serverFeatures[featureKey]);
            });

            applyFeatureToggles(features, false);
            try {
                await saveUserPreference(`features.${key}`, newValue);
            } catch (error) {
                checkbox.checked = previousValue !== false;

                const revertedFeatures = {};
                ['chat', 'headerBranding', 'search', 'syncButton'].forEach(featureKey => {
                    revertedFeatures[featureKey] = featureKey === key
                        ? previousValue
                        : getUserPreference(`features.${featureKey}`, serverFeatures[featureKey]);
                });
                applyFeatureToggles(revertedFeatures, false);
                toast.error(error.message || 'Failed to save feature preference.');
                return;
            }
            console.log(`Feature toggle ${key} changed to: ${newValue}`);
        });

        const featureLabel = createElement('label', {
            htmlFor: `user-pref-feature-${key}`,
            textContent: label,
        });

        featureGroup.appendChild(checkbox);
        featureGroup.appendChild(featureLabel);
        container.appendChild(featureGroup);
    });

    // Clear Continue Watching button
    const clearContinueWatchingGroup = createElement('div', {
        className: 'form-group form-group-separator',
    });

    clearContinueWatchingGroup.appendChild(createElement('label', {
        textContent: 'Video Progress',
    }));

    clearContinueWatchingGroup.appendChild(createElement('div', {
        className: 'config-description',
        textContent: isAdmin
            ? 'Clears video progress for the currently selected profile only. Shared server resets live in Server Settings.'
            : 'Permanently removes all video playback progress stored for this browser session.',
    }));

    const clearCWButton = createElement('button', {
        textContent: 'Clear All Video Progress',
        className: 'btn btn--danger btn--sm',
    });

    lifecycle.on(clearCWButton, 'click', async () => {
        if (!await dialog.confirm('Clear all video progress?\n\nThis will permanently remove all video playback progress. Your entire watch history will be lost, not just the Continue Watching row.\n\nThis cannot be undone.', { type: 'danger' })) {
            return;
        }

        const originalText = clearCWButton.textContent;
        clearCWButton.textContent = 'Clearing...';
        clearCWButton.disabled = true;

        try {
            if (hasActiveProfile()) {
                const response = await fetch('/api/progress/clear-continue-watching', { method: 'POST' });
                const result = await response.json();

                if (response.ok && result.success) {
                    toast.success(`Profile video progress cleared successfully. ${result.cleared_count || 0} videos removed.`);

                    const streamingLayout = window.ragotModules?.streamingLayout;
                    if (streamingLayout?.isActive?.()) {
                        await streamingLayout.buildContinueWatchingData?.();
                        streamingLayout.render?.();
                    }
                } else {
                    toast.error(`Error: ${result.error || 'Failed to clear video progress'}`);
                }
            } else {
                const { clearAllVideoProgress } = await import('../../../utils/progressDB.js');
                const clearedCount = await clearAllVideoProgress();

                toast.success(`Video progress cleared successfully. ${clearedCount} videos removed.`);

                const streamingLayout = window.ragotModules?.streamingLayout;
                if (streamingLayout?.isActive?.()) {
                    await streamingLayout.buildContinueWatchingData?.();
                    streamingLayout.render?.();
                }
            }
        } catch (error) {
            console.error('[ConfigModal] Error clearing Continue Watching:', error);
            toast.error('An error occurred while clearing video progress. Check the console for details.');
        } finally {
            clearCWButton.textContent = originalText;
            clearCWButton.disabled = false;
        }
    });

    clearContinueWatchingGroup.appendChild(clearCWButton);
    container.appendChild(clearContinueWatchingGroup);

    fragment.__cleanup = () => {
        lifecycle.stop();
        themeChangedHandler = null;
    };
    return fragment;
}
