import { execFileSync } from 'node:child_process';

// Independent standard-library ZIP/XML reader, not the workbook-writing library.
export function spreadsheetRows(bytes:Uint8Array):string[][] {
  return JSON.parse(execFileSync('python3',['-c',String.raw`
import io,json,re,sys,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert sum(v.file_size for v in z.infolist()) < 40000000
assert not any('vba' in n.lower() or 'externallinks' in n.lower() for n in z.namelist())
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
for n in z.namelist():
 if n.endswith('.xml') or n.endswith('.rels'):
  root=E.fromstring(z.read(n))
  assert not root.findall('.//s:f',ns)
  assert not any(e.attrib.get('TargetMode')=='External' for e in root.iter())
def text(s):
 return re.sub(r'_x([0-9a-fA-F]{4})_',lambda m:chr(int(m[1],16)),s)
strings=[text(''.join(e.itertext())) for e in E.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si',ns)]
rows=[]
for row in E.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('s:sheetData/s:row',ns):
 values=[]
 for c in row.findall('s:c',ns):
  column=0
  for letter in re.match('[A-Z]+',c.attrib['r'])[0]:column=column*26+ord(letter)-64
  while len(values)<column:values.append('')
  v=c.find('s:v',ns)
  assert c.attrib.get('t')=='s' or v is None
  if v is not None:values[column-1]=strings[int(v.text)]
 rows.append(values)
print(json.dumps(rows,ensure_ascii=True))
`],{input:bytes,encoding:'utf8',maxBuffer:8_388_608}));
}
