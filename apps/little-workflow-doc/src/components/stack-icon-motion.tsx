'use client';

import { useEffect } from 'react';

const IDLE_MS = 5_000;
const PLAYBACK_MS = 12_000;
const COOLDOWN_MS = 60_000;
const ICON_SELECTOR = 'svg[data-stack-icon]';
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'] as const;

type AvatarState = 'plain' | 'playing' | 'still';
type MotionState = 'active' | 'playing' | 'still' | 'reduced' | 'hidden';

/** One controller for server-rendered icons, including icons mounted by navigation. */
export function StackIconMotion() {
  useEffect(() => {
    const root = document.documentElement;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const icons = new Set<SVGSVGElement>();
    const visibleIcons = new Set<SVGSVGElement>();
    let motion: MotionState = 'active';
    let lastActivity = Date.now();
    let nextSequenceAt = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let playbackTimer: ReturnType<typeof setTimeout> | undefined;

    function setMotion(next: MotionState) {
      motion = next;
      root.dataset.avatarMotion = next;
    }

    function setAvatar(icon: SVGSVGElement, state: AvatarState) {
      if (icon.dataset.avatarState !== state) icon.dataset.avatarState = state;
    }

    function clearTimers() {
      clearTimeout(idleTimer);
      clearTimeout(playbackTimer);
      idleTimer = undefined;
      playbackTimer = undefined;
    }

    function armIdleTimer() {
      clearTimeout(idleTimer);
      idleTimer = undefined;
      if (motion !== 'active' || document.hidden || reducedMotion.matches) return;

      const delay = Math.max(lastActivity + IDLE_MS, nextSequenceAt) - Date.now();
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        if (document.hidden || reducedMotion.matches || visibleIcons.size === 0) return;

        setMotion('playing');
        // Cooldown extends beyond the full sequence even if activity interrupts it.
        nextSequenceAt = Date.now() + PLAYBACK_MS + COOLDOWN_MS;
        visibleIcons.forEach((icon) => setAvatar(icon, 'playing'));
        playbackTimer = setTimeout(() => {
          playbackTimer = undefined;
          setMotion('still');
          visibleIcons.forEach((icon) => setAvatar(icon, 'still'));
          // No rearming here: remaining idle must never loop the sequence.
        }, PLAYBACK_MS);
      }, Math.max(0, delay));
    }

    function resetForActivity() {
      clearTimers();
      lastActivity = Date.now();
      icons.forEach((icon) => setAvatar(icon, 'plain'));
      setMotion(document.hidden ? 'hidden' : reducedMotion.matches ? 'reduced' : 'active');
      armIdleTimer();
    }

    const intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const icon = entry.target as SVGSVGElement;
        const visible = entry.isIntersecting && entry.intersectionRatio > 0;
        icon.dataset.visible = String(visible);
        if (visible) {
          visibleIcons.add(icon);
          // Joining an existing idle scene does not start a second sequence.
          if (motion === 'playing' || motion === 'still') setAvatar(icon, 'still');
        } else {
          visibleIcons.delete(icon);
          setAvatar(icon, 'plain');
        }
      }
      if (visibleIcons.size > 0 && idleTimer === undefined) armIdleTimer();
    });

    function registerIcons(node: Node) {
      if (!(node instanceof Element)) return;
      const candidates = node.matches(ICON_SELECTOR)
        ? [node as SVGSVGElement]
        : node.querySelectorAll<SVGSVGElement>(ICON_SELECTOR);

      for (const icon of candidates) {
        if (icons.has(icon)) continue;
        icons.add(icon);
        setAvatar(icon, 'plain');
        intersectionObserver.observe(icon);
      }
    }

    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) mutation.addedNodes.forEach(registerIcons);
      // Navigation and menus can remove entire subtrees. Release their references.
      for (const icon of icons) {
        if (icon.isConnected) continue;
        intersectionObserver.unobserve(icon);
        visibleIcons.delete(icon);
        icons.delete(icon);
      }
    });

    registerIcons(document.body);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    ACTIVITY_EVENTS.forEach((event) => document.addEventListener(event, resetForActivity, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', resetForActivity);
    reducedMotion.addEventListener('change', resetForActivity);
    resetForActivity();
    root.dataset.avatarMotionReady = 'true';

    return () => {
      clearTimers();
      mutationObserver.disconnect();
      intersectionObserver.disconnect();
      ACTIVITY_EVENTS.forEach((event) => document.removeEventListener(event, resetForActivity, { capture: true }));
      document.removeEventListener('visibilitychange', resetForActivity);
      reducedMotion.removeEventListener('change', resetForActivity);
      icons.forEach((icon) => {
        setAvatar(icon, 'plain');
        icon.dataset.visible = 'false';
      });
      delete root.dataset.avatarMotionReady;
      delete root.dataset.avatarMotion;
    };
  }, []);

  return null;
}
