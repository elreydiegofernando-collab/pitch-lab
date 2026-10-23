/**
 * A music word the singer can tap to read its plain explanation (src/teach/glossary.ts).
 * CONTRACT STUB: the plain-language builder replaces the body (tap to open a sheet) and keeps the props.
 */
import type { ComponentChildren, JSX } from 'preact';
import { TERMS, type TermId } from '../../teach/glossary';

export interface TermProps {
  id: TermId;
  /** The words shown (default: the term's own word); e.g. "in tune" inside a sentence. */
  children?: ComponentChildren;
}

export function Term(props: TermProps): JSX.Element {
  return <span class="pl-term" data-term={props.id}>{props.children ?? TERMS[props.id]}</span>;
}
