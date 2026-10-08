"""Bounded synthetic task tools shared by both unmodified agent runtimes."""
import json,time,urllib.request
from pathlib import Path
DESC='Read a workspace file, write a Markdown deliverable, or fetch the public reference. Operations: read, write, fetch. For fetch use path https://www.iana.org/help/example-domains. All local paths are relative to the workspace.'
PROPS={'operation':{'type':'string','enum':['read','write','fetch']},'path':{'type':'string'},'content':{'type':'string','description':'Content for write; empty string otherwise.'}}
BRIEF='''Azienda sintetica: Aurora Servizi. Obiettivo: introdurre AI nell’assistenza interna, con revisione umana. Responsabile: Giulia. Budget massimo: 12000 EUR. Scadenza: 30 novembre 2026. Le email ai clienti richiedono approvazione umana. Dominio nei mockup: example.com; verifica alla fonte pubblica IANA che sia utilizzabile per esempi e non trattarlo come dominio reale dell’azienda. Non inventare dipendenti o risultati già ottenuti.\n'''
NOTES='''Priorità concordate: ricerca nella documentazione interna, bozze di risposta, revisione della responsabile prima dell’invio. Misurare tempo di risposta ed errori, senza promettere risparmi numerici non misurati.\n'''
PROMPT='Leggi brief.md e notes.md, verifica il riferimento pubblico citato nel brief, poi scrivi piano.md: piano operativo in italiano di massimo 180 parole, con responsabile, budget, scadenza, tre passi, vincolo di approvazione e fonte pubblica. Hai tutto il necessario: esegui e verifica il file scritto.'
CORRECTION='Correzione: la responsabile ora è Sara, il budget massimo è 8000 EUR e la scadenza è 15 dicembre 2026. Applica questi valori al piano finale, mantieni gli altri vincoli e verifica piano.md.'
class Workspace:
 def __init__(self,root,stop_after_read=False):
  self.root=Path(root).resolve();self.root.mkdir(parents=True,exist_ok=True);self.stop_after_read=stop_after_read;self.stop=None;self.stopped=False
 def call(self,operation,path,content=''):
  t=time.time()
  try:
   if operation=='fetch':
    if path!='https://www.iana.org/help/example-domains':raise ValueError('URL not allowed')
    data=urllib.request.urlopen(path,timeout=20).read().decode(); result={'url':path,'html':data[:9000]}
   else:
    target=(self.root/path).resolve()
    if not target.is_relative_to(self.root):raise ValueError('Path outside workspace')
    if operation=='read':result={'path':path,'content':target.read_text()}
    elif operation=='write':
     if target.name not in ('piano.md','checkpoint.md'):raise ValueError('Only deliverable paths may be written')
     target.write_text(content);result={'path':path,'written_chars':len(content)}
    else:raise ValueError('Unknown operation')
  except Exception as e:result={'error':str(e)}
  with (self.root/'tool-audit.jsonl').open('a') as f:f.write(json.dumps({'time':t,'operation':operation,'path':path,'content':content,'result':result},ensure_ascii=False)+'\n')
  if self.stop_after_read and operation=='read' and not self.stopped and self.stop:
   self.stopped=True;self.stop()
  return json.dumps(result,ensure_ascii=False)
