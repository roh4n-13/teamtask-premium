/* TeamTask — Web Push client module (standalone, no framework).
 *
 * HOW IT IS WIRED (at wiring time, in index.html):
 *   <script type="module">
 *     import { enablePush, disablePush } from './push.js';
 *     // …after Supabase is wired and the user is signed in…
 *   </script>
 *
 * CALLING RULES — read before calling enablePush():
 * - Call enablePush() ONLY from a user gesture, e.g. an "Enable
 *   notifications" affordance in the You tab. NEVER call it on first
 *   load / on sign-in: browsers may ignore or penalise a permission
 *   prompt that was not user-initiated, and a denied prompt cannot be
 *   re-asked from code (the user must re-enable it in browser settings).
 * - Call disablePush(sb, profileId) inside signOut(), so a signed-out
 *   browser stops receiving that user's pushes.
 *
 * This file creates NO Supabase client and contains NO Supabase URL or
 * key. The caller passes in `sb` — the supabase-js client the wiring
 * step creates — and `profileId` — the signed-in user's profiles.id.
 */

// The real VAPID public key for this app (public by design — it is
// safe to ship in client code). The matching PRIVATE key is held
// separately by the parent (0600 file) and is set as an Edge Function
// secret later; it must never appear in this repo.
export const VAPID_PUBLIC_KEY =
  'BIVVDKPXmanAHe1__oiioRJ2GwqGOcYJdv5PXVaxp3KDkLl4okOi-nza-ZeKB_depUuweSUmQ89EcHWP9B4Z8kg';

/**
 * Convert a URL-safe base64 VAPID public key to the Uint8Array that
 * pushManager.subscribe() requires.
 */
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** Serialise a PushSubscription's keys to base64url strings. */
function subscriptionKeys(subscription) {
  const key = (name) => {
    const raw = subscription.getKey(name);
    if (!raw) return null;
    return btoa(String.fromCharCode(...new Uint8Array(raw)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  };
  return { p256dh: key('p256dh'), auth: key('auth') };
}

/**
 * Enable Web Push for the signed-in user.
 *
 * @param {object} sb        - the supabase-js client (created by the wiring step)
 * @param {string} profileId - the signed-in user's profiles.id
 * @returns {Promise<{ok: boolean, reason: string, endpoint?: string}>}
 *   ok=false reasons: 'unsupported' | 'permission_denied' |
 *   'permission_dismissed' | 'no_subscription' | 'db_error' | 'subscribe_error'
 */
export async function enablePush(sb, profileId) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (!sb || !profileId) {
    return { ok: false, reason: 'no_client_or_profile' };
  }

  let registration;
  try {
    // Relative path + scope: the app is deployed under a sub-path
    // (GitHub Pages /teamtask-premium/), so an absolute '/sw.js' would
    // 404 at the domain root. './' resolves to the app's own directory.
    registration = await navigator.serviceWorker.register('sw.js', { scope: './' });
    // subscribe() throws "no active Service Worker" while the worker is
    // still installing — wait until it is active first.
    await navigator.serviceWorker.ready;
  } catch (err) {
    console.error('[push] service worker registration failed:', err);
    return { ok: false, reason: 'sw_register_failed' };
  }

  // Only ask if the user has not already decided. If they denied it,
  // only a browser-settings change can undo that — say so plainly.
  if (Notification.permission === 'denied') {
    return { ok: false, reason: 'permission_denied' };
  }
  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return {
        ok: false,
        reason: permission === 'denied' ? 'permission_denied' : 'permission_dismissed',
      };
    }
  }

  let subscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  } catch (err) {
    console.error('[push] pushManager.subscribe failed:', err);
    return { ok: false, reason: 'subscribe_error' };
  }
  if (!subscription) {
    return { ok: false, reason: 'no_subscription' };
  }

  const { p256dh, auth } = subscriptionKeys(subscription);
  if (!p256dh || !auth) {
    return { ok: false, reason: 'no_subscription_keys' };
  }

  // One row per (user, browser endpoint); re-enabling on the same
  // browser updates the existing row instead of duplicating it.
  const { error } = await sb
    .from('push_subscriptions')
    .upsert(
      {
        user_id: profileId,
        endpoint: subscription.endpoint,
        p256dh,
        auth,
        user_agent: navigator.userAgent,
      },
      { onConflict: 'user_id,endpoint' },
    );
  if (error) {
    console.error('[push] push_subscriptions upsert failed:', error);
    return { ok: false, reason: 'db_error' };
  }

  return { ok: true, reason: 'enabled', endpoint: subscription.endpoint };
}

/**
 * Disable Web Push for the signed-in user: unsubscribe the browser
 * and delete the matching push_subscriptions row.
 * Call this inside signOut().
 *
 * @param {object} sb        - the supabase-js client (created by the wiring step)
 * @param {string} profileId - the signed-in user's profiles.id
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
export async function disablePush(sb, profileId) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (!sb || !profileId) {
    return { ok: false, reason: 'no_client_or_profile' };
  }

  let registration;
  try {
    // No-arg getRegistration returns the registration for this page's
    // scope (the app's own directory under GitHub Pages).
    registration = await navigator.serviceWorker.getRegistration();
  } catch (err) {
    console.error('[push] getRegistration failed:', err);
    return { ok: false, reason: 'sw_error' };
  }
  if (!registration) {
    return { ok: true, reason: 'already_disabled' };
  }

  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    return { ok: true, reason: 'already_disabled' };
  }

  const endpoint = subscription.endpoint;
  try {
    await subscription.unsubscribe();
  } catch (err) {
    console.error('[push] unsubscribe failed:', err);
    return { ok: false, reason: 'unsubscribe_error' };
  }

  const { error } = await sb
    .from('push_subscriptions')
    .delete()
    .eq('user_id', profileId)
    .eq('endpoint', endpoint);
  if (error) {
    console.error('[push] push_subscriptions delete failed:', error);
    return { ok: false, reason: 'db_error' };
  }

  return { ok: true, reason: 'disabled' };
}
