/** Where the Git page shows a folder (`tree`) or a file (`blob`) of one ref, under the page's root. */
export const filesPath = (root: string, ref: string, path: string, file = false) =>
  `${root}/${file ? 'blob' : 'tree'}/${encodeURIComponent(ref)}${path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''}`;
