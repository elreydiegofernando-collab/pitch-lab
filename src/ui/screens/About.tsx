/** About & voice care: privacy, the voice-care note, open-source and song credits, and the version. */
import type { JSX } from 'preact';
import { ChevronDown, Heart } from 'lucide-preact';
import { back } from '../../router';
import { songIndex } from '../../state/songs';
import { AppBar } from '../components/AppBar';
import { Card } from '../components/Card';
import { VoiceCareNote } from '../components/VoiceCareNote';

/** Mirrors package.json's "version" — the ui agent does not edit package.json; see integrationNotes. */
const APP_VERSION = '0.1.0';

export function About(): JSX.Element {
  const bundled = [...songIndex.value.values()].filter((song) => song.bundled);

  return (
    <div class="pl-screen" data-testid="about-screen">
      <AppBar title="About & voice care" routeIcon={Heart} onBack={() => back()} />
      <div class="pl-scroll">
        <div class="pl-page">
          <Card>
            <span class="pl-display-m">Privacy</span>
            <p class="pl-body pl-prose">
              Your voice audio never leaves this device unless you export it. Pitch Lab makes no analytics calls and no third-party
              requests while you use it, and nothing you sing is uploaded anywhere.
            </p>
            <p class="pl-body-s pl-muted pl-prose">
              Two things can leave on purpose, only when you tap them in Data &amp; backup: a take&apos;s WAV file, and a backup of your
              progress (which carries no audio). Songs you import stay on this device too.
            </p>
          </Card>

          <Card>
            <span class="pl-display-m">Voice care</span>
            <VoiceCareNote />
          </Card>

          <Card>
            <span class="pl-display-m">Open-source credits</span>
            <ul class="pl-stack pl-body-s pl-muted pl-care-list">
              <li>Big Shoulders Display &amp; Instrument Sans fonts &mdash; SIL Open Font License 1.1</li>
              <li>lucide-preact icons &mdash; ISC License</li>
              <li>Preact &amp; @preact/signals &mdash; MIT License</li>
              <li>@tonejs/midi &mdash; MIT License</li>
              <li>Workbox (offline support) &mdash; MIT License</li>
            </ul>
          </Card>

          <Card>
            <span class="pl-display-m">Song credits</span>
            <p class="pl-body-s pl-muted pl-prose">
              The starter songs are public-domain melodies and words. Each chart was made for Pitch Lab and is shared under the MIT License.
            </p>
            {bundled.length > 0 ? (
              <details class="pl-credits" data-testid="song-credits">
                <summary class="pl-body-s">
                  <span>Show the credits for {bundled.length} songs</span>
                  <ChevronDown class="pl-credits__chev" size={20} aria-hidden="true" />
                </summary>
                <ul class="pl-stack pl-care-list">
                  {bundled.map((song) => (
                    <li key={song.id}>
                      <span class="pl-data">{song.title}</span>
                      <span class="pl-body-s pl-muted"> &middot; {song.artist}</span>
                      {song.licence ? <p class="pl-body-s pl-lo pl-prose">{song.licence}</p> : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : (
              <p class="pl-body-s pl-lo">The credit for each song appears here once the song library has loaded.</p>
            )}
          </Card>

          <p class="pl-body-s pl-lo">Pitch Lab v{APP_VERSION}</p>
        </div>
      </div>
    </div>
  );
}
