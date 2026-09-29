# Public website and shared Clubhouse playback

The public front door is `/`. `/watch` lists only releases explicitly published by Kade; the family Library never becomes public automatically. Sign-in opens `/home`, with the Library, Clubhouse, creative tools, and chat. Chat remains at `/c/new`; existing conversations and API addresses keep working.

## Publishing

From Home, choose **Publish on my website** (`/publish`). Choose an original Library audio/video recording, add a public title and description, confirm that its complete file may be public, then publish. The resulting `/watch/<slug>` link works without an account. Taking a release down closes its page immediately and stops new signed links. Previously issued links expire within one hour. Removing or replacing the source file also closes the release.

## Family feature pack

The admin dashboard (`/usage-dashboard`) and Library page use the same per-person on/off control and existing owner-only membership API. The current live roster was explicitly reconciled on September 28, 2026: Kade Murdock, Holly Murdock, Afton Harper, Amber A, Amber Lacey, Wiley Murdock, Corey Murdock, Destiny, Crystal Butler, Skylee Murdock, and Karen Laws. All other current accounts have `kadeLibraryAccess: none`. New accounts do not inherit the pack. Turning it off preserves their own uploads.

## Watch and listen together

Join a Clubhouse room, open **Choose from the library**, find shared audio or video, and choose a recording. It starts paused. The chooser controls play, pause, seeking, and stop for the room. Everyone's account must independently have access to the file; child restrictions still apply. A late arrival catches up to the room's position. After the host has been absent for 25 seconds another eligible listener can take over.

**My library media volume** affects only your device. Hide the picture to listen without displaying video; this does not convert the file or reduce its download size. **Rejoin playback** starts listening if the browser requires a tap. Media streams straight from storage to each listener. It is not sent through anyone's microphone and is not part of the room recording. The existing conversation and jukebox recording behavior is unchanged.

Supported playback depends on the device's media codecs. This is Clubhouse synchronization, not Apple SharePlay. The native iPhone source is prepared separately, with AVPlayer, VoiceOver controls, route/interruption handling, and a Foundation timing test gate. No native build or device validation was requested for this release.

## Verification

- `node --test api/test/community.integration.test.cjs` uses a real temporary MongoDB for public-release boundaries, family/child permissions, two rooms, host controls, late joining, concurrent updates, takeover, and revocation.
- `node node_modules/typescript/bin/tsc -p dev/community-tsconfig.json` checks the new server types and membership dependency.
- The normal API/schema and client builds remain required.
- `node dev/community-preview.cjs` runs an isolated preview on port 4179 with synthetic accounts and MongoDB. It never uses production accounts or media. Supply `dev/preview.mp4` with a locally generated silent test clip for media checks. The preview also serves the real admin dashboard with synthetic membership and empty spending data.
- Physical iPhone, VoiceOver, AirPlay, and Bluetooth call/playback checks remain for the later authorized native build.
