import type { Connection } from './database.ts';
import { ApiError,type AreaRef } from './policy.ts';

export interface AreaSelection {countryIds:string[];regionIds:string[];cityIds:string[]}
export async function selectedAreas(db:Connection,input:AreaSelection):Promise<AreaRef[]> {
  const rows=(await db.query<{ref:AreaRef}>(`SELECT ref FROM public.geographic_areas WHERE
    (kind='country' AND id=ANY($1::uuid[])) OR (kind='region' AND id=ANY($2::uuid[])) OR (kind='city' AND id=ANY($3::uuid[])) ORDER BY kind,id`,
    [input.countryIds,input.regionIds,input.cityIds])).rows;
  if(rows.length!==input.countryIds.length+input.regionIds.length+input.cityIds.length)throw new ApiError(400,'INVALID_REFERENCE');
  return rows.map(r=>r.ref);
}
export async function hubsForAreas(db:Connection,areas:AreaRef[],uncertain=false) {
  if(!areas.length)return [];
  return (await db.query<{id:string}>(`SELECT h.id FROM public.hub_geography h WHERE EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) a
    WHERE public.area_matches_hub(a,h.ref,$2)) ORDER BY h.id`,[JSON.stringify(areas),uncertain])).rows.map(r=>r.id);
}
export async function areaFor(db:Connection,kind:AreaRef['kind'],id:string) {
  const row=(await db.query<{ref:AreaRef}>('SELECT ref FROM public.geographic_areas WHERE kind=$1 AND id=$2',[kind,id])).rows[0];
  if(!row)throw new ApiError(400,'INVALID_REFERENCE');return row.ref;
}
export async function areaDependencies(db:Connection,areas:AreaRef[]) {
  if(!areas.length)return [];
  return (await db.query(`SELECT kind,id,name,version,active,ref FROM public.geographic_areas g WHERE EXISTS(
    SELECT 1 FROM jsonb_array_elements($1::jsonb) a WHERE (g.kind='country' AND g.id=(a->>'countryId')::uuid)
    OR (g.kind='region' AND g.id=(a->>'regionId')::uuid) OR (g.kind='city' AND g.id=(a->>'cityId')::uuid)) ORDER BY kind,id`,[JSON.stringify(areas)])).rows;
}
