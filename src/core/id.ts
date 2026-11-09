// Stable unique ids for every record. The app plugs in a cryptographic generator at startup.
let generator: () => string = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

export function setIdGenerator(fn: () => string): void {
  generator = fn;
}

export function newId(): string {
  return generator();
}
