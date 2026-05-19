/**
 * Swipe Navigation Utility
 * Reusable vertical swipe, keyboard, and mouse wheel navigation for layouts.
 * 
 * Extracted from default layout's touchNavigation.js for use in new layouts.
 * Horizontal swipe gestures are handled separately by shared gestures.js
 */
import { Module, $ } from '../libs/ragot.esm.min.js';

// Configuration defaults
const DEFAULT_CONFIG = {
    swipeThreshold: 50,      // Minimum pixels for swipe detection
    wheelDebounceDelay: 300, // ms between wheel events
    containerSelector: null, // Element selector for visibility checks
    excludeSelectors: [      // Elements that block swipe handling
        '#chat-container',
        '.modal:not(.hidden)',
        '.gh-theme-builder',
        '.media-controls',
        '.gh-back-btn',
        '.vc-bottom',
        '.vc-center-play',
        '.vc-skip'
    ]
};

// State
let config = { ...DEFAULT_CONFIG };
let startY = 0;
let isSwiping = false;
let hasMoved = false;
let pausedForSwipe = false;
let wheelDebounceTimeout;
let swipeLifecycle = null;

// Handler references for cleanup
let handleTouchStart, handleTouchMove, handleTouchEnd, handleKeyDown, handleMouseWheel;

// Callbacks
let onSwipeUp = null;
let onSwipeDown = null;
let onTap = null;
let getActiveVideoElement = null;
let isContainerVisible = null;
let isNavigationDisabled = null;

/**
 * Check if event target is in an excluded area
 */
function isExcludedTarget(e) {
    return config.excludeSelectors.some(sel => e.target.closest(sel));
}

/**
 * Check if container is visible and navigation is allowed
 */
function canNavigate() {
    if (isContainerVisible && !isContainerVisible()) return false;

    const isPreview = document.body.classList.contains('theme-builder-preview');
    const isEdit = document.body.classList.contains('theme-builder-active');

    // Block in edit mode unless preview
    if (isEdit && !isPreview) return false;

    // Allow in preview mode even if navigation disabled
    if (isPreview) return true;

    // Check if navigation is disabled
    if (isNavigationDisabled && isNavigationDisabled()) return false;

    return true;
}

/**
 * Pause active video during swipe
 */
function pauseVideoForSwipe() {
    if (pausedForSwipe) return;

    const video = getActiveVideoElement?.();
    if (video && video.tagName === 'VIDEO' && !video.paused) {
        pausedForSwipe = true;
        video.pause();
    }
}

/**
 * Resume active video after cancelled swipe
 */
function resumeActiveVideo() {
    const video = getActiveVideoElement?.();
    if (video && video.tagName === 'VIDEO') {
        video.loop = true;
        video.play().catch(err => console.error("Resume play failed:", err));
    }
}

/**
 * Toggle video playback (for tap events)
 */
function togglePlayback() {
    const video = getActiveVideoElement?.();
    if (video && video.tagName === 'VIDEO') {
        video.loop = true;
        if (video.paused) {
            video.play().catch(err => console.error("Play failed:", err));
        } else {
            video.pause();
        }
    }
}

/**
 * Setup vertical swipe navigation
 * @param {Object} options Configuration options
 * @param {Function} options.onSwipeUp Called when user swipes up (next item)
 * @param {Function} options.onSwipeDown Called when user swipes down (prev item)
 * @param {Function} [options.onTap] Called when user taps (default: toggle playback)
 * @param {Function} [options.getActiveVideoElement] Returns current video element for pause/resume
 * @param {Function} [options.isContainerVisible] Returns true if swipe container is visible
 * @param {Function} [options.isNavigationDisabled] Returns true if navigation should be blocked
 * @param {string} [options.containerSelector] CSS selector for container (for wheel events)
 * @param {number} [options.swipeThreshold] Min pixels for swipe detection (default: 50)
 * @param {number} [options.wheelDebounceDelay] Ms between wheel events (default: 300)
 * @param {string[]} [options.excludeSelectors] Selectors to exclude from swipe handling
 */
export function setupSwipeNavigation(options = {}) {
    // Cleanup existing listeners
    cleanupSwipeNavigation();
    if (!swipeLifecycle) {
        swipeLifecycle = new Module();
    }
    swipeLifecycle.start();

    // Apply configuration
    config = { ...DEFAULT_CONFIG, ...options };

    // Store callbacks
    onSwipeUp = options.onSwipeUp;
    onSwipeDown = options.onSwipeDown;
    onTap = options.onTap || togglePlayback;
    getActiveVideoElement = options.getActiveVideoElement;
    isContainerVisible = options.isContainerVisible;
    isNavigationDisabled = options.isNavigationDisabled;

    const containerElement = config.containerSelector
        ? $(config.containerSelector)
        : null;

    // Touch start handler
    handleTouchStart = (e) => {
        if (isExcludedTarget(e)) return;
        if (isContainerVisible && !isContainerVisible()) return;
        if (window.ragotModules?.fullscreenManager?.hasRecentFullscreenExit?.()) return;

        // Block in theme builder edit mode
        if (document.body.classList.contains('theme-builder-active') &&
            !document.body.classList.contains('theme-builder-preview')) {
            return;
        }

        startY = e.touches[0].clientY;
        isSwiping = true;
        hasMoved = false;
        pausedForSwipe = false;
    };

    // Touch move handler
    handleTouchMove = (e) => {
        if (isExcludedTarget(e)) return;
        if (!isSwiping) return;
        if (isContainerVisible && !isContainerVisible()) return;

        const currentY = e.touches[0].clientY;

        if (!hasMoved && Math.abs(currentY - startY) > 10) {
            hasMoved = true;
            pauseVideoForSwipe();
        }

        if (Math.abs(currentY - startY) > 10) {
            e.preventDefault();
        }
    };

    // Touch end handler
    handleTouchEnd = (e) => {
        if (isExcludedTarget(e)) return;
        if (isContainerVisible && !isContainerVisible()) return;
        if (!isSwiping) return;

        isSwiping = false;

        const endY = e.changedTouches[0].clientY;
        const diffY = startY - endY;
        const absDiffY = Math.abs(diffY);

        if (absDiffY > config.swipeThreshold) {
            if (!canNavigate()) {
                // Navigation disabled - just toggle playback
                onTap?.();
            } else if (diffY > config.swipeThreshold) {
                // Swipe up = next
                onSwipeUp?.(e);
            } else if (diffY < -config.swipeThreshold) {
                // Swipe down = prev
                onSwipeDown?.(e);
            } else {
                resumeActiveVideo();
            }
        } else {
            // Small movement or tap
            if (!hasMoved) {
                onTap?.();
            } else {
                resumeActiveVideo();
            }
        }
    };

    // Keyboard handler
    handleKeyDown = (e) => {
        if (isContainerVisible && !isContainerVisible()) return;
        if (!canNavigate() && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            onSwipeUp?.(e); // Down arrow = next (same as swipe up)
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            onSwipeDown?.(e); // Up arrow = prev (same as swipe down)
        }
    };

    // Mouse wheel handler
    handleMouseWheel = (e) => {
        if (containerElement && containerElement.classList.contains('hidden')) return;
        if (e.target.closest('.modal:not(.hidden)')) return;

        e.preventDefault();

        if (!canNavigate()) return;

        clearTimeout(wheelDebounceTimeout);
        wheelDebounceTimeout = setTimeout(() => {
            if (e.deltaY > 0) {
                onSwipeUp?.(e); // Scroll down = next
            } else if (e.deltaY < 0) {
                onSwipeDown?.(e); // Scroll up = prev
            }
        }, config.wheelDebounceDelay);
    };

    // Attach listeners
    swipeLifecycle.on(document.body, 'touchstart', handleTouchStart, { passive: false });
    swipeLifecycle.on(document.body, 'touchmove', handleTouchMove, { passive: false });
    swipeLifecycle.on(document.body, 'touchend', handleTouchEnd, { passive: false });
    swipeLifecycle.on(document, 'keydown', handleKeyDown);

    if (containerElement) {
        swipeLifecycle.on(containerElement, 'wheel', handleMouseWheel, { passive: false });
    }
}

/**
 * Cleanup all swipe navigation listeners
 */
export function cleanupSwipeNavigation() {
    if (swipeLifecycle) {
        swipeLifecycle.stop();
    }

    // Clear timeout
    clearTimeout(wheelDebounceTimeout);

    // Reset handlers
    handleTouchStart = null;
    handleTouchMove = null;
    handleTouchEnd = null;
    handleKeyDown = null;
    handleMouseWheel = null;
}
