import { visible } from '@merv/contracts';
import { z } from 'zod';

/**
 * A synopsis is a plain paragraph of 40–420 trimmed characters, with no entity IDs or Markdown.
 * The tool and the service share this rule; whether one is required is the stored review's.
 */
const synopsisRule = (text: z.ZodString) =>
  text.refine(
    (synopsis) =>
      visible(synopsis) &&
      synopsis.trim().length >= 40 &&
      synopsis.trim().length <= 420 &&
      !/[\r\n\u2028\u2029`]|\*\*|__|\]\(|<\/?[a-z]+>/iu.test(synopsis) &&
      !/^\s*(?:#|[-*+]\s|\d+[.)]\s|>)/u.test(synopsis) &&
      !/\b(?:wf|art|review|actor|project|context|exp|task|claim|res|rver|syn|rev|lit|paper)_[A-Za-z0-9]/u.test(
        synopsis,
      ),
    'Supply a plain single-paragraph synopsis of 40–420 characters, without entity IDs or Markdown',
  );
export const synopsisSchema = synopsisRule(z.string());
/** The tool also publishes the untrimmed length cap agents have always seen. */
export const synopsisToolSchema = synopsisRule(z.string().min(1).max(420));
