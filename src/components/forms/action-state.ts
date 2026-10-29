/** Result of a form server action, already localized for display. */
export interface ActionState {
  ok?: boolean;
  /** Increments on every completed submission so forms can react (e.g. new idempotency key). */
  seq?: number;
  message?: string;
  formError?: string;
  fieldErrors?: Record<string, string>;
  /** Submitted values, used to repopulate the form after an error. */
  values?: Record<string, string>;
  data?: Record<string, string>;
}

export const initialActionState: ActionState = {};
