/** TextField: a labelled text input (profile names, typed confirmations). 17px text so iOS does not zoom the page on focus. */
import type { JSX } from 'preact';

export interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onInput: (value: string) => void;
  hint?: string;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  /** Typed confirmations (a name, DELETE) must not be "helped" by the keyboard. */
  literal?: boolean;
  'data-testid'?: string;
}

export function TextField(props: TextFieldProps): JSX.Element {
  const { id, label, value, onInput, hint, placeholder, maxLength, disabled = false, literal = false } = props;
  return (
    <div class="pl-field">
      <label class="pl-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        class="pl-field__input"
        type="text"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        autoComplete="off"
        autoCapitalize={literal ? 'off' : 'words'}
        autoCorrect="off"
        spellcheck={false}
        enterKeyHint="done"
        aria-describedby={hint ? `${id}-hint` : undefined}
        data-testid={props['data-testid']}
        onInput={(e) => onInput(e.currentTarget.value)}
      />
      {hint ? (
        <p id={`${id}-hint`} class="pl-body-s pl-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
