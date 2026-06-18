# Shortcuts setup — arming the Focus input

Goal: when a Focus turns **on**, the phone POSTs that state to the Worker; when it turns
**off**, it POSTs `idle`. Do this on **both phones**.

- **Endpoint:** `https://living-widget.ethanwfang.workers.dev/update`
- **Header:** `Authorization: Bearer <YOUR_SHARED_TOKEN>`
- **user value:** `her` on her phone, `you` on your phone
- **state value:** matches a state `id` in `config.json` (`gym`, `study`, `sleep`, `relax`), or `idle`

You need **2 automations per Focus mode** (one ON, one OFF). With 4 active Focus modes
that's 8 automations per phone. Build the first one fully, then duplicate.

---

> **iOS version note:** these steps are for **iOS 17 / 18 / 26** (current). The big
> difference from older guides: **Run Immediately** is now chosen on the *trigger setup
> screen*, before you tap Next — there is no separate "Ask Before Running" toggle on a
> later screen anymore.

## Build automation #1 in full — "Gym turns ON" (her phone)

1. Open **Shortcuts** app → bottom tab **Automation** → **+** (top right).
   - If it asks, choose **Create Personal Automation**. (On current iOS the **+** often
     jumps straight to the trigger list — that's fine.)
2. In the trigger list, scroll to and tap **Focus**.
3. On the Focus setup screen:
   - Tap **Choose** and select the Focus mode **Gym**.
   - Make sure **"Is Turned On"** is checked (leave "Is Turned Off" unchecked).
   - Below that, select **Run Immediately** (not "Run After Confirmation").
4. Tap **Next** (top right).
5. You land on the shortcut editor. Tap the search/**Add Action** field and search
   **"Get Contents of URL"** → tap it to add it.
6. Tap the **URL** field in the action → type/paste:
   ```
   https://living-widget.ethanwfang.workers.dev/update
   ```
7. Tap **Show More** (the ▸ row under the action) to reveal the options, then set:
   - **Method:** change `GET` → **POST**
   - **Headers:** tap **Add new header**
     - Key: `Authorization`
     - Value: `Bearer <YOUR_SHARED_TOKEN>`   ← paste your real token after "Bearer "
   - **Request Body:** tap and choose **JSON**, then **Add new field** (keep type **Text**):
     - Key `user`  → Value `her`
     - **Add new field** again: Key `state` → Value `gym`
8. Tap **Done** (top right) to save.

That's one automation. Toggling **Gym on** now POSTs `{"user":"her","state":"gym"}`.

---

## Build automation #2 — "Gym turns OFF" (her phone)

Same as above, except:
- Step 3: check **"Is Turned Off"** (uncheck "Is Turned On").
- Step 7 body: `state` = **`idle`**.

---

## Duplicate for the rest

The only things that change between automations are **the Focus picked** (step 3),
**Is Turned On vs Off** (step 3), and the **`state` value** (step 7). Build the table below — 2 per Focus:

| Focus mode | Turning ON → state | Turning OFF → state |
|------------|--------------------|---------------------|
| Gym        | `gym`              | `idle`              |
| Study      | `study`            | `idle`              |
| Sleep      | `sleep`            | `idle`              |
| Relax      | `relax`            | `idle`              |

> Tip: Shortcuts doesn't let you duplicate an *automation* directly, but you can keep the
> Get Contents of URL action identical and only retype the one `state` value each time.
> Fastest path: build all 4 "ON" automations, then all 4 "OFF" automations.

On **your phone**, repeat everything with `user` = **`you`**.

---

## The OFF → idle caveat (read this)

Each "turns off" automation blindly sets `idle`. If she runs **two** Focus modes at once
(rare, but possible) and turns one off, it'll set `idle` even though another Focus is still on.
For two people casually using one Focus at a time this is fine. If it becomes a problem,
the fix is to not send `idle` on every off — but start simple.

---

## Test it

After building at least the Gym ON automation:
1. Settings → Focus → turn **Gym** on (or use Control Center).
2. On a computer:
   ```
   curl -s https://living-widget.ethanwfang.workers.dev/state
   ```
   `her` should now read `gym`.
3. Turn Gym off → `/state` should show `her: idle` again.

If `/state` doesn't change: the automation is set to **"Run After Confirmation"** (you'll
see a notification you must tap instead of it running silently), or the token/body is wrong.
Open the automation and re-check that it's **Run Immediately**, Method = **POST**, the
**Authorization** header, and the JSON fields.
