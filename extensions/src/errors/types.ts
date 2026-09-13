export type AttemptSuccess<T> = {
  success: true;
  value: T;
  error: undefined;
};

export type AttemptFailure = {
  success: false;
  value: undefined;
  error: unknown;
};

export type AttemptResult<T> = AttemptSuccess<T> | AttemptFailure;
