# Writing places in Reverie

Kade is the founder. Souls and Synths share the world; this authoring layer does not change their canon or identification rules.

The waterfront is built from `api/app/clients/tools/kademoo/world/waterfront.rev`. That file is executable world data, loaded by the game. You can write places with names, connected exits, senses, sounds, and button actions without writing JavaScript. This is the first small layer of an Inform/MOO-style authoring system, not a complete scripting language or in-game editor.

For example:

```text
Place porch in sweetwater.
Name: the Garden Porch
Description: A low porch with a long bench. South returns to the garden.
Outside: no
Ground: wood.interior
Smell: Cedar and mint.
Listen: Leaves brush the posts.
Doings: Rest together on the bench.
Ambience: amb.reeds.breeze
South: garden
Action: rest on the porch | Rest on the porch | You settle beside the mint. | hangout.seat | settles on the garden porch.

Link garden north to porch.
```

This example is illustrative; `garden` must be an existing room, and its north direction must be free. Use actual place ids from the world. The shipped waterfront file is a complete working example.

Each `Place` requires a unique id, a known ward, `Name`, `Description`, `Smell`, `Listen`, and at least one exit. The directions are north, south, east, west, northeast, northwest, southeast, southwest, up, down, in, and out. Put a destination id after the colon. Reverse exits must be written explicitly. `Link` connects an existing place to your new place. Lines beginning with `#` are comments.

Optional fields are `Outside: yes` or `no`, `Ground`, `Water: river`, `harbor`, or `lake`, `Ambience`, and `Doings`. Ground supports wood.interior, cobble, grass.dry, dirt.packed, linoleum, carpet, and metal.stair. Ambience names an installed `amb.` sound id. An absent recording does not prevent play. Write meaningful descriptions and senses even when a picture or sound is available.

An `Action` has five parts separated by `|`: the lower-case command, button label, personal result, sound id, and public action after the player's name. These actions require the player to be in that place. They add a small amount of fun and rest, cost no money, and share a fifteen-second cooldown. They cannot execute code, alter inventories, or create arbitrary effects. More complex mechanics belong in reviewed TypeScript game modules.

Run from the repository root:

```sh
node dev/reverie/check-world.cjs
node --require ./api/test/reverie-bootstrap.cjs packages/api/src/reverie/waterfront.harness.cjs
```

The compiler reports invalid fields and duplicate commands with line numbers. Seeding checks connector rooms against the database. Production seeding inserts new places and adds only unused connector directions; it preserves founder edits to existing rooms and exits. Editing an already-seeded description in this file will therefore not replace live prose. Use an explicit reviewed migration for that change. Source is loaded once per process, so a release or restart is required after editing it.

The current loader reads the waterfront file only. To add another source file, explicitly register it in the loader and validate it together with the existing actions so commands cannot collide. Room pictures are a separate presentation layer; custom scenery still needs a renderer. Every gameplay action must retain an ordinary labeled control for keyboard, touch, and screen-reader use.
