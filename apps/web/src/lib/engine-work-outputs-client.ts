import { ENGINE_DEFAULT_BASE_URL } from './engine-client.ts';
import { DEFAULT_WORKSPACE_ID, defaultLocalActor, domainFetch } from './engine-domain-client.ts';
import { homunErrorFromHttp } from './homun-errors.ts';

export type WorkOutput={id:string;work_id:string;run_id:string;filename:string;sha256:string;byte_size:number;review_status:string};
async function request(workId:string,suffix='') {
  const response=await domainFetch(`/v1/workspaces/${DEFAULT_WORKSPACE_ID}/works/${encodeURIComponent(workId)}/outputs${suffix}`,{
    headers:{'X-Homun-Actor-Id':defaultLocalActor().id},
  },ENGINE_DEFAULT_BASE_URL,30000);
  if(!response.ok)throw homunErrorFromHttp(response.status,await response.json(),'File del lavoro non disponibile');
  return response;
}
export async function listWorkOutputs(workId:string):Promise<WorkOutput[]> {
  return (await (await request(workId)).json()).items;
}
export async function downloadWorkOutput(workId:string,output:WorkOutput):Promise<Blob> {
  const response=await request(workId,`/${encodeURIComponent(output.id)}/download`);
  return response.blob();
}
