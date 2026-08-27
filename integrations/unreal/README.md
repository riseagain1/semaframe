# Unreal Engine 5.6+ editor bridge

The `SemaFrameBridge` content plugin uses Unreal's USD Importer and Python Editor Script plugins to open `scene.usda` on a USD Stage Actor. It maps each manifest `usdPrimPath` back to its SemaFrame stable ID, and can explicitly submit mapped component transforms as a review-only change proposal.

## Install and connect

1. Copy `integrations/unreal/SemaFrameBridge` into `YourProject/Plugins/SemaFrameBridge`.
2. Use Unreal Engine 5.6 or newer. Enable **SemaFrame Bridge**, **USD Importer**, and **Python Editor Script Plugin**, then restart the editor.
3. Create a Bridge session targeting Unreal and copy its setup JSON. Before launching the editor, move the clipboard value into a process environment variable without writing it to a file or literal shell-history entry. On macOS:

   ```sh
   export SEMAFRAME_BRIDGE_SETUP="$(pbpaste)"
   "/path/to/UnrealEditor" "/path/to/YourProject.uproject"
   unset SEMAFRAME_BRIDGE_SETUP
   ```

   In PowerShell, use `$env:SEMAFRAME_BRIDGE_SETUP = Get-Clipboard`, launch `UnrealEditor.exe`, then `Remove-Item Env:SEMAFRAME_BRIDGE_SETUP`. Launch the editor executable directly from that shell; GUI launch helpers may not pass its environment through reliably.

4. In Unreal's Python console, consume the already-captured setup and pull:

   ```python
   import semaframe_bridge
   semaframe_bridge.connect_from_environment()
   semaframe_bridge.pull_latest_exchange()
   ```

5. After the USD Stage finishes loading, run `semaframe_bridge.refresh_stable_id_mapping()`. Edit the generated USD components, then explicitly run `semaframe_bridge.submit_transform_proposal()`. The proposal is queued for SemaFrame review; it never commits directly.

The adapter removes `SEMAFRAME_BRIDGE_SETUP` from the process environment as soon as its startup module loads, validates the document's target/session/loopback URLs/authorization, and clears the setup text after connection. It keeps only the capability in module memory and does not accept it as a function parameter or store it in Actor tags, config, logs, or files. A `SEMAFRAME_BRIDGE_BEARER` launch variable plus non-secret endpoint/session arguments remains a manual compatibility fallback. Disconnect with `semaframe_bridge.disconnect()`.

## Security and fidelity

- HTTP is restricted to explicit-port loopback origins. Proxies and redirects are disabled; responses are bounded; the archive digest and every declared artifact digest are verified.
- Extraction accepts only the five Scene Exchange paths and rejects traversal, unknown entries, encrypted files, symlinks, and case-fold duplicates.
- Unreal's USD Stage is the visual/scenegraph path. Optional STEP and GLB files are retained in the extracted exchange but are not misrepresented as native Unreal assets.
- Unreal uses centimetres and a left-handed Z-up coordinate system. Transform proposals convert generated USD component values back to SemaFrame metres/radians in right-handed Y-up coordinates.
- The USD Stage Actor owns generated components and can recreate them. Refresh the stable-ID mapping after a stage reload before proposing edits.
- v1 returns at most 100 changed transforms per proposal. Unreal materials, Blueprints, collisions, level-specific objects, and USD layer edits remain downstream work.
