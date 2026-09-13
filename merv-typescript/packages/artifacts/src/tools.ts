import type { Context } from 'cordis'
import { z } from 'zod'
export const artifactToolsPlugin={name:'merv-artifact-tools',inject:['artifacts','tools'],apply(ctx:Context){
  const register=(name:string,description:string,inputSchema:z.ZodTypeAny,handler:any,readOnly=false)=>ctx.effect(()=>ctx.tools.register({name,description,inputSchema,handler,readOnly}))
  register('artifact.create','Store a completed immutable document or file (maximum 2 MB). Use utf8 for Markdown/text; use base64 for binary files. Returns an artifact ID for task briefs and deliveries.',z.object({title:z.string().min(1).max(300),content:z.string().min(1).max(2_700_000),mediaType:z.string().optional(),encoding:z.enum(['utf8','base64']).optional()}).strict(),(c:any,i:any)=>ctx.artifacts.create(c,i))
  register('artifact.get','Read immutable artifact metadata.',z.object({artifactId:z.string().min(1)}).strict(),(c:any,i:any)=>ctx.artifacts.get(c,i.artifactId),true)
  register('artifact.read','Read immutable artifact content; binary content is returned as base64.',z.object({artifactId:z.string().min(1)}).strict(),(c:any,i:any)=>ctx.artifacts.read(c,i.artifactId),true)
  register('artifact.list','List immutable artifacts in this project.',z.object({}).strict(),(c:any)=>ctx.artifacts.list(c),true)
}}
export default artifactToolsPlugin
