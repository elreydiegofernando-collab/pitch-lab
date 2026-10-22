/** ImportReportView: what an imported backup did, in plain words (the Data screen). A glyph and the headline carry the tone, never colour alone. */
import type { JSX } from 'preact';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-preact';
import type { ImportSummary } from './import-report';

const TONE_ICON = { ok: CircleCheck, warn: TriangleAlert, error: CircleAlert } as const;

export function ImportReportView(props: { summary: ImportSummary }): JSX.Element {
  const { tone, headline, lines, details } = props.summary;
  const ToneIcon = TONE_ICON[tone];
  return (
    <div class={`pl-data-report pl-data-report--${tone}`} role={tone === 'error' ? 'alert' : 'status'} data-testid="import-report">
      <p class="pl-data-report__head">
        <ToneIcon size={20} strokeWidth={2} aria-hidden="true" />
        <span>{headline}</span>
      </p>
      {lines.length > 0 ? (
        <ul class="pl-data-report__lines pl-body-s">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {details.length > 0 ? (
        <details class="pl-data-report__details">
          <summary class="pl-body-s">Show what could not be read</summary>
          <ul class="pl-body-s pl-muted">
            {details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
