# Mobile frontend polish: theming, chrome, and empty states

**Status:** Draft for `/plan-issue` — not yet an issue. Being iterated on
directly via `/ui` in the meantime (see Progress log below); `/plan-issue`
can still be run against whatever's left unfinished here.

## Progress log

This is the running ledger for `/ui`-driven work on this doc — the `/ui`
agent has no memory between invocations, so this section (and the
per-finding status lines under Part A/B below) is its only continuity.
When `/ui` finishes something from this doc, it updates the matching
finding's status line in place and adds one line here: date, what shipped,
which file(s).

- 2026-09-17: doc moved off `main` onto its own branch
  (`ui/branch-and-spec-tracking`) instead of sitting uncommitted on
  `main` — no polish work done yet.

**How this doc was produced:** built and installed the current working tree
(uncommitted changes included) on two Android emulators (Pixel 10 Pro A/B,
one left in dark mode, one in light mode) via `npx expo run:android`,
logged in as two real seeded accounts that are already mutual contacts, and
clicked through Login → Conversations → Chat → Settings → Friends →
AddContact on both devices, screenshotting each stop. Every finding below
was seen on-device, not guessed from source alone (source was then read to
confirm root cause and locate the exact fix point).

## Part A — carry forward as-is (already implemented, uncommitted)

**Status: DONE.** Shipped via PR #154 (safe-area insets + Friends
refetch fix) and PR #155 (QUIC keep-alive + Android build fixes),
2026-09-17. Kept below for the historical record; nothing left to do here.

These are bug fixes already sitting in the working tree (`git status` at
the top of this session). They're bundled into the same issue because
they're already done, already have matching test updates, and are exactly
the kind of low-risk same-surface changes AGENTS.md's bundling rule is
for — nothing here needs re-litigating, just carrying forward:

1. **Safe-area insets** (`App.tsx`, `ChatScreen.tsx`, `ConversationsScreen.tsx`,
   `FriendsScreen.tsx`) — wraps the app in `SafeAreaProvider` and applies
   `useSafeAreaInsets()` padding to the Chat composer (bottom) and the
   Conversations/Friends headers (top). Tests already updated to seed
   `SafeAreaProvider initialMetrics`.
2. **Friends list goes stale after accepting a request** (`FriendsScreen.tsx`)
   — accept now re-pulls both `listContacts()` and `listContactRequests()`
   instead of only clearing the request locally, and refetches on tab
   focus. Test added: "refetches when the screen regains focus."
3. **QUIC connection dropping every ~5s during idle chat** (`packages/quic-relay-client/src/lib.rs`)
   — root cause: `max_idle_timeout(5s)` with no keep-alive meant any quiet
   chat session (no messages either direction) hit the idle timeout and
   reconnected constantly. Fix adds `keep_alive_interval(2s)` so Quinn
   emits its own PINGs and a healthy connection never goes idle long
   enough to trip the timeout.
4. **Android native build fixes** (`apps/mobile/modules/quic-relay-client/android/{CMakeLists.txt,build.gradle}`,
   `react-native.config.js`, `package.json`) — corrected codegen output
   paths, dropped an unused JNA dependency, and narrowed `abiFilters` to
   `x86_64` (emulator-only; flag to the Coder that this last one should be
   revisited before a real-device/physical-arm64 build).

## Part B — new findings from the visual walkthrough

### B1. Native screen chrome ignores the app's dark/light mode

**Status: not started.**

`App.tsx`'s `NavigationContainer` has no `theme` prop, so React Navigation
always paints native chrome (stack headers, and intermittently the bottom
tab bar) with its light-mode default — regardless of the in-app
Settings → Appearance choice that already correctly themes every screen
*body* via NativeWind's `dark:` classes.

Seen on-device: opening Chat, Settings, or AddContact from a fully dark
themed app instantly shows a stark white header bar with black text above
a black screen body. Screenshots: Chat (`b@b.com` thread), Settings.

**Fix:** derive a React Navigation theme (`DarkTheme`/`DefaultTheme` from
`@react-navigation/native`) from the same source `colorScheme`/theme
preference already used for the NativeWind classes (see
`src/settings/preferences.ts`, `App.tsx`'s `themeReady` effect), and pass
it to `NavigationContainer`. This also fixes the tab bar's inconsistent
background (observed switching between light and dark backgrounds across
otherwise-identical Conversations screenshots taken seconds apart).

### B2. Every pushed screen shows two headers

**Status: not started.**

`AddContact`, `UserProfile`, `Chat`, and `Settings` are registered in
`App.tsx` with no `options`, so each gets React Navigation's default
native header **in addition to** that screen's own custom in-body header
row. Result, seen on every one of these four screens:

- Chat: native header says "Chat"; body repeats the contact as "b@b.com"
  immediately below it.
- Settings: native header says "Settings"; body repeats "Settings" as its
  own heading immediately below it.
- AddContact: native header shows the **raw route name** `AddContact`
  (unhumanized, camelCase leaking straight into user-facing UI); body
  shows a properly-cased "Add contact" heading immediately below it.
- UserProfile: same pattern by inspection (no `options`, no in-screen back
  handling either — see B2 fix note).

None of these four screens implement their own back navigation (`grep` for
`goBack`/`headerShown` across all four returns nothing) — they rely
entirely on the native header's automatic back arrow. So the fix isn't
just "hide the native header":

**Fix:** for all four screens, set `headerShown: false` in `App.tsx` (same
pattern already used for `Login`/`Main`), and add each screen its own
themed header row matching the existing `ConversationsScreen`/
`FriendsScreen` convention: a back button (`navigation.goBack()`) + title,
built with the same `dark:`/safe-area-inset pattern already established.
This also fixes the raw-route-name leak on AddContact for free, since the
new header supplies its own copy instead of React Navigation defaulting to
the route name.

### B3. Tab bar icons are React Navigation's "missing icon" placeholder

**Status: not started.** Note the new-dependency flag below still applies —
`/ui` should not add `@expo/vector-icons` on its own say-so without
checking in first, since that's exactly the kind of thing this doc already
flagged as needing a separate issue.

`MainTabs.tsx` never sets `tabBarIcon`, and no icon library
(`@expo/vector-icons` or similar) is a dependency anywhere in
`apps/mobile` (confirmed: absent from `package.json` and `node_modules`).
React Navigation's bottom-tabs falls back to its built-in missing-icon
glyph — the thin rectangular outline visible above both "Conversations"
and "Friends" labels on both emulators, light and dark.

**Fix:** add `@expo/vector-icons` and wire real icons — e.g. Ionicons
`chatbubbles`/`chatbubbles-outline` for Conversations,
`people`/`people-outline` for Friends — with active/inactive tinting via
`tabBarActiveTintColor`/`tabBarInactiveTintColor` (or the token color from
Part C).

**Flag for the Planner:** this is a *new dependency*, which AGENTS.md's
Planner playbook hard-excludes from bundling regardless of how related it
looks to everything else here. Recommend splitting this one bullet into
its own tiny issue (add the dependency, wire two icons — genuinely a
20-minute change) and bundling the rest of this doc into the main issue,
rather than folding it in and quietly breaking that rule. Flagging rather
than deciding unilaterally since you were explicit about wanting one
issue — your call when you run `/plan-issue`.

### B4. Severe dead space on every list/detail screen

**Status: not started.**

Conversations, Friends, and any Chat thread with few messages all
top-align their content and leave the remaining viewport (70-90% of
screen height in the seeded two-account test data) as flat, undifferentiated
black or white space. No empty-state illustration, no centered prompt, no
visual anchor — it reads as an unfinished screen rather than a
deliberately short list.

**Fix:**
- Add a real empty state for zero-item lists: centered icon + one line of
  copy + a CTA where relevant ("No conversations yet" → hint to add a
  friend first; "No contacts yet" already exists as text per FriendsScreen
  test coverage — give it the same centered treatment instead of a
  top-pinned line).
- For non-empty-but-short lists, this doc does **not** recommend
  vertically centering rows (that would jump around as items are added) —
  just make sure the empty state and any "you've reached the end" framing
  reads as intentional rather than as blank space.

### B5. Login screen is visually unbalanced and generic

**Status: not started.**

Content (wordmark, two inputs, button, sign-up link, dev-only QUIC-spike
link) sits pinned roughly two-thirds down the screen with a large,
purposeless gap above it. The "Epistl" wordmark is plain bold system-font
blue text with no distinct identity; inputs are plain bordered boxes;
the primary button is a flat pastel blue with low contrast against its own
white label. For a privacy-first, post-quantum-encrypted messenger, this
is the very first impression a user gets and currently reads as an
unstyled placeholder rather than an intentional front door.

**Fix:** see Part C for the concrete direction — this screen is the one
place in this bundle that gets a real visual treatment, not just a chrome
fix.

### B6. Conversation/Friend rows are plain text-only

**Status: not started.**

Rows show only the contact's raw email address, last-message preview, and
relative time — no avatar/initial for at-a-glance scanning, and no visible
unread indicator distinct from the (currently untested-in-this-walkthrough)
bold-weight convention. With more than one or two contacts this will be
hard to scan quickly.

**Fix:** add a small initial-letter avatar circle (derived from the email,
no new dependency — just a colored `View`+`Text`) to each row in both
Conversations and Friends, and confirm/strengthen the unread visual (a
small dot in the accent color, not just font-weight, which is easy to
miss).

## Part C — visual direction (token system)

Scope note: this bundle is a polish/bug-fix pass, not a ground-up redesign
— per AGENTS.md's bundling rule, it needs to stay roughly one coherent
day's work. So the direction below is deliberately restrained: it fixes
the "looks unfinished" problem (B4-B6) and gives the app one distinctive
accent instead of default iOS blue, without pulling in new fonts or
restructuring every screen's layout. If it grows past that after a first
implementation pass, split the visual-identity bullets (C1-C3 below) into
their own follow-up issue rather than stretching this one.

**Color.** The app already commits to a stark near-black (`#000000`) /
near-white (`#FFFFFF`) base per screen — that's a good, distinctive
starting point (most chat apps default to a soft gray, not true
black/white) and this doc keeps it. What's missing is a deliberate accent:
right now every primary action uses the platform-default iOS blue
(`#3B82F6`-ish), which reads as "unstyled default" rather than a choice.
Epistl is Latin for "letter" — lean into correspondence/sealing-wax
association rather than generic chat-app blue:

- `--ink` `#141118` — primary text on light backgrounds, and this app's
  actual near-black dark-mode background (slightly warmer than pure
  `#000` so it doesn't compete with the pure-black status bar/tab bar).
- `--paper` `#FAF9F7` — light-mode background (a warm off-white instead of
  clinical pure white — still reads as "light mode," feels like paper).
- `--seal` `#8B2F4B` — the one deliberate accent: a muted wine/sealing-wax
  red-violet. Replaces default blue on primary buttons, active tab tint,
  links, and the unread-dot from B6. Used sparingly (per the frontend-design
  skill's "spend your boldness in one place" — this is that one place).
- `--seal-muted` `#8B2F4B` at 12% opacity — selected/pressed-state washes
  (e.g. the Settings Appearance segmented control's selected pill).
- `--slate` `#6B6570` — secondary text, borders, placeholder text (replaces
  the current generic `gray-200`/`gray-700` Tailwind defaults with a
  warmer neutral that sits better next to `--seal`).
- `--danger` `#D33F3F` — keep the existing danger-zone/log-out red roughly
  as-is; it's already doing its job and doesn't need to compete with
  `--seal`.

**Type.** No new font dependency. Keep the system font
(San Francisco/Roboto) for every screen's body text — it's free,
native-feeling, and correctly localized/accessible out of the box. The
only typographic change is to the "Epistl" wordmark on Login: increase its
weight and tracking slightly and set it in `--seal` instead of default
blue, so it reads as a wordmark rather than a bold hyperlink. Everywhere
else, keep the existing scale (screen titles ~20/28, body ~16, secondary
~13) — it's already reasonable, it just needs the color/spacing fixes
above more than a new scale.

**Layout.** One-sentence concept: *quiet, correspondence-style
minimalism* — generous flat color fields, one accent used only for
actions and unread state, content left-aligned throughout (already the
case), no cards/shadows/gradients anywhere (already the case — don't
introduce the generic SaaS-card kit here).

```
Login (current)                       Login (revised)
+----------------------+              +----------------------+
|                      |              |     [ big gap ]      |
|     (empty)          |              |                      |
|                      |              |       Epistl          <- seal-
|                      |              |  private messaging       colored
|      Epistl          |              |                        wordmark
|  [ email        ]    |              |  [ email        ]    |
|  [ password     ]    |              |  [ password     ]    |
|  [   Log in     ]    |              |  [   Log in     ]    |  <- seal
|  Sign up link        |              |    Sign up link      |     fill
|                      |              |                      |
| (large empty void)   |              |     (empty)          |
+----------------------+              +----------------------+
```

The revised layout moves the form up into the vertical center-ish third
(roughly 40% from top instead of 65%), adds a one-line subtitle under the
wordmark ("Private, post-quantum-secure messaging" or similar — final copy
is the Coder's/your call), and gives the button a solid `--seal` fill with
white text (current button is a pale blue fill with white text at low
contrast).

```
Conversations row (current)           Conversations row (revised)
+--------------------------+          +--------------------------+
| b@b.com             5h   |          | (B)  b@b.com         5h  |
| Sup                       |          |  •   Sup                 |
+--------------------------+          +--------------------------+
                                        ^avatar circle   ^unread dot
                                         (initial "B")    (seal color,
                                                           only if unread)
```

**Principles.**
1. One accent, used consistently for the same meaning everywhere (primary
   action, active tab, link, unread) — never decorative.
2. No screen shows two headers. One title, one back button, themed.
3. No screen shows a native-default light header inside a dark-mode
   session, or vice versa.
4. A short list gets a designed empty state, never a top-pinned row over a
   void.
5. Nothing here requires a new font or restructures a screen's
   information architecture — this is a finishing pass, not a rebuild.

## Suggested issue split (for `/plan-issue` to confirm or override)

- **Issue 1 (main bundle):** Part A (carry-forward fixes) + B1, B2, B4,
  B5, B6 + Part C's token/visual work. One screen-family (auth + main
  nav chrome + list screens), all low-risk, no new dependency, no data
  model change — fits AGENTS.md's bundling rule.
- **Issue 2 (tiny, separate — new dependency):** B3, tab bar icons via
  `@expo/vector-icons`. Hard-excluded from bundling per AGENTS.md
  regardless of how small it is, since it's a new dependency.

## Out of scope for this bundle

- Physical-device / real-arm64 QUIC relay client builds (the `abiFilters`
  narrowing to `x86_64` in Part A should be revisited before that, flagged
  as a follow-up, not fixed here).
- Push notifications (`Settings` already marks this "Coming soon — not
  yet functional"; unrelated to this visual/chrome pass).
- Any new font/typeface, illustration assets, or app-icon/splash-screen
  changes.
- Avatars beyond a colored initial circle (no photo upload, no server-side
  avatar storage).
