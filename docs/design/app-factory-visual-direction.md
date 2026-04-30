# App Factory Visual Direction

Data: 2026-04-30

## Obiettivo

Le applicazioni generate da App Factory devono sembrare piccole app curate, non admin template o form builder. La UI e' parte della killer feature: l'utente deve percepire che Homun compone un prodotto interno usabile, non solo un database con campi.

## Linea Guida: Crafted Internal App

La direzione visuale di default per i runtime esterni e':

- shell unica centrata, con bordi morbidi e ombra controllata;
- sfondo caldo/neutro, ma app shell chiara e leggibile;
- top bar compatta con brand, nome app, badge live e account;
- sidebar leggera con icone lineari e voci umane;
- contenuto centrale dominante, non soffocato da card ripetute;
- pannello laterale per quick create/dettaglio con accento colore;
- search integrata nell'header della lista;
- empty state illustrato, semplice e contestuale;
- stati workflow come pill morbide;
- niente `snake_case` visibile all'utente.

## Regole Di Composizione

1. Usare meno card: una shell principale, una lista centrale, un pannello operativo.
2. Le metriche devono essere compatte e contestuali; non devono dominare la pagina.
3. Le label devono essere business-friendly e derivate da `navigation.label`, `field.label` o `entity.label`.
4. I form devono sembrare strumenti rapidi, non sezioni tecniche.
5. I campi system/workflow non devono comparire come input utente.
6. Le azioni disponibili devono essere visibili solo quando hanno senso nel contesto selezionato.
7. Ogni nuovo modulo UI deve seguire questa gerarchia: brand, navigation, primary work area, contextual side panel.

## Template Iniziale

Il primo template implementato e' `approval/list app`, usato da ferie/permessi e riusabile per ticket interni:

```text
App Shell
  Top Bar
  Sidebar Navigation
  Main List/Table
  Side Panel Quick Create + Detail + Actions
```

Questo template rimane la base finche' non vengono introdotti template specifici come CRM, inventory o calendar-first.
