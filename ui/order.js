const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const compareNames = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));
export const byName = (a, b) => compareNames(a.name ?? a.directory, b.name ?? b.directory);
