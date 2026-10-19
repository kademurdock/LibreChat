import { Router } from 'express';
import type { RequestHandler } from 'express';
import { familyLibraryMember } from '../library/access';
import type { LibraryAccount } from '../library/access';

/* ----------------------------------------------------------------------------
 * THE FAMILY FEATURE PACK (Sep 25 2026, Part 293)
 *
 * Her words: "call it the family feature pack... each family feature is some
 * kind of premium event, whatever we don't want going public." "If I let bob
 * down the fictional street have an account on here, I'm not going to let him
 * have access to the downloader, or my public shelving content in Library."
 * "Just have the box greyed out for non-fam."
 *
 * The pack IS the Library's family permission (library/access.ts
 * familyLibraryMember): admins always; the App Review seat never; test seats
 * never unless Kade grants one; 'family' or 'none', once Kade sets it, is final;
 * accounts made before FAMILY_LIBRARY_CUTOFF keep it; later accounts wait for
 * her yes. Kade turns it on and off in the Library's "Family feature pack"
 * section; the stored field is still `kadeLibraryAccess`.
 *
 * Clients read one map per person (familyFeatures) so a future pack feature
 * needs no app build: a feature that is false is shown greyed out with
 * FAMILY_PACK_NOTE, never hidden (Apple's 2.3.1 forbids hiding features from
 * review).
 *
 * KADE_FAMILY_PACK_LINKS: the describer's link import and the Clubhouse
 * jukebox's song links join the pack only when it is exactly '1'. Default off,
 * because the submitted iPhone 2.2.0's review notes promise the demo account
 * can use them. The Sound Booth's media link is the pack's either way.
 *
 * Part 295 (Sep 27 2026): the Sound Booth's trained styles (trainedStyles) join
 * the pack. The Soul style was taught from commercial soul and R&B records, so
 * its Style choice is greyed out for everyone outside the pack and refused by
 * the server (FAMILY_PACK_STYLES_REFUSAL). Booth words name no person, so that
 * refusal does not say who to ask.
 * A style taught from songs made with Suno (Oct 2026) was taught from AI-made
 * songs, not records, and sits behind the same pack for a different reason:
 * Suno's terms are read as restricting use of its output to build competing
 * models, so it is a private style tool for the family. That gate must stay:
 * one pack answer covers every style, and no style is opened to everyone.
 * YuE2's Sona (Oct 2026, taught from songs made with Sonauto) is one more row
 * behind that same answer.
 *
 * Oct 18 2026: the Arcade's family games (arcadeFamily) join the pack. A game
 * on the family shelf is played from a pack of game files kept in private
 * storage, so it is the family's alone; one pack answer covers every family
 * game. Outside the pack the arcade shows one greyed "Family shelf" entry with
 * no game names (the App Review seat included), and its routes refuse with
 * FAMILY_PACK_ARCADE_REFUSAL (arcade/router.ts).
 * -------------------------------------------------------------------------- */

/** One person's pack features. True means usable now; false means shown greyed out. */
export interface FamilyFeatures {
  /** The media-link downloader: the Sound Booth's cover link from YouTube and other media sites. */
  mediaLinks: boolean;
  /** The video describer's link import (in the pack only while KADE_FAMILY_PACK_LINKS is '1'). */
  describerLinks: boolean;
  /** The Clubhouse jukebox's song links (in the pack only while KADE_FAMILY_PACK_LINKS is '1'). */
  jukeboxLinks: boolean;
  /** Kade's shared Library shelves. */
  familyLibrary: boolean;
  /** The Sound Booth's trained styles (the Style choice): YuE2's Kids, Soul, Suno and Sona and, behind
   * ACE_STYLES_ENABLED, ACE-Step XL's Soul and Suno. Kids and Soul were taught from real recordings,
   * commercial songs among them; Suno and Sona from songs made with Suno and with Sonauto. They are one
   * pack feature, so one answer covers every style (Part 295, Sep 27 2026; ACE-Step XL, Oct 11 2026). */
  trainedStyles: boolean;
  /** The Arcade's family shelf: every game whose catalog entry says access 'family' (Oct 18 2026). */
  arcadeFamily: boolean;
}

/** What GET /api/kade/features answers. */
export interface FamilyFeaturesView {
  familyPack: boolean;
  name: string;
  /** The visible and accessible description beside every greyed-out pack control. */
  note: string;
  /** The words a pack-gated route answers with (403). */
  refusal: string;
  features: FamilyFeatures;
}

export const FAMILY_PACK_NAME: string = 'Family feature pack';
export const FAMILY_PACK_NOTE: string = 'Part of the Family feature pack';
export const FAMILY_PACK_REFUSAL: string =
  'Media links are part of the Family feature pack. Ask Kade to add it to your account.';

/** What the Sound Booth answers (403) when an account outside the pack asks for a trained style. */
export const FAMILY_PACK_STYLES_REFUSAL: string =
  'Trained styles are part of the Family feature pack, and this account does not have it. Set Style to None, then make the music again.';

/** What the Arcade answers (403) when an account outside the pack asks for a family game. */
export const FAMILY_PACK_ARCADE_REFUSAL: string =
  'This game is on the family shelf. Ask Kade for the Family feature pack to play it.';

/** True when the describer's and the jukebox's links belong to the pack (env exactly '1'). */
export function familyPackLinksGated(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KADE_FAMILY_PACK_LINKS === '1';
}

/** Has this account got the Family feature pack? The Library's family permission, unchanged. */
export function familyPack(user: LibraryAccount | null | undefined): boolean {
  return familyLibraryMember(user);
}

/** The per-feature map every client reads. Nobody signed in gets nothing. */
export function familyFeatures(
  user: LibraryAccount | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FamilyFeatures {
  const pack = familyPack(user);
  const open = !!user && (pack || !familyPackLinksGated(env));
  return {
    mediaLinks: pack,
    describerLinks: open,
    jukeboxLinks: open,
    familyLibrary: pack,
    trainedStyles: pack,
    arcadeFamily: pack,
  };
}

export function familyFeaturesView(
  user: LibraryAccount | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FamilyFeaturesView {
  return {
    familyPack: familyPack(user),
    name: FAMILY_PACK_NAME,
    note: FAMILY_PACK_NOTE,
    refusal: FAMILY_PACK_REFUSAL,
    features: familyFeatures(user, env),
  };
}

type SignedIn = { user?: LibraryAccount };

/** GET / -> familyFeaturesView for the signed-in person (mounted at /api/kade/features). */
export function familyFeaturesRouter(auth: RequestHandler): Router {
  const router = Router();
  router.get('/', auth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(familyFeaturesView((req as SignedIn).user));
  });
  return router;
}
