/** Fail create-only migrations when a Contentstack entry UID is already known. */
export function assertCreateOnlyNoExistingEntry(opts: {
  wpId: number;
  existingUid?: string;
  entityLabel: string;
}): void {
  const uid = opts.existingUid?.trim();
  if (!uid) return;
  throw new Error(
    `Contentstack ${opts.entityLabel} entry already exists for wp_id=${opts.wpId} (uid=${uid}); ` +
      `create-only migration does not update existing entries`
  );
}
