/** A new unique id (a v4 UUID) for a project item, job or request. The one
 *  place ids are minted, in main and the renderer alike (`crypto` is a global
 *  in both). */
export const newId = (): string => crypto.randomUUID()
