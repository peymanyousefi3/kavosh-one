// Quoting is not a formula-injection defense. Prefix untrusted free text,
// including Unicode/control-prefixed formulas,without changing stored data.
// Never apply this to validated code-generated signed decimal money strings.
export function csvText(value:string){return /^(?:[\t\r\n]|[\s\p{Cc}\p{Cf}]*[=+\-@＝＋－＠])/u.test(value)?'text: '+value:value;}
export function csvRow(row:readonly(string|number|boolean|null|undefined)[]){return row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',');}
