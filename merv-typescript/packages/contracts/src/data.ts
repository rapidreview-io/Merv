export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Data = Record<string, Json>;
