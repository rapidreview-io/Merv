import { paperInput } from '@merv/paper/context';
import type { Paper, PaperWorkspace } from '@merv/paper/types';

/** A paper with nothing written, for a Tasks fixture without the Paper service. */
export const blankPaper = {
  contextInput: async () => paperInput({} as PaperWorkspace['documents'], 0),
  introduction: async () => ({ revision: 0, text: '' }),
} as unknown as Paper;
