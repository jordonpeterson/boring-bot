export const hello = (): string => {
  return "Hello from @boring-bot/repositories";
};

// Lint test: no-inferrable-types should remove the `: number` annotation
export const lintTest: number = 42;
