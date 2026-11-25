import { REPO_URL } from '../config';
import { h, icon, ICONS } from '../dom';
import { KINDS } from '../kinds';
import { KindIcon } from './KindIcon';

/** "About & method" dialog. */
export class AboutModal {
  readonly el: HTMLDialogElement;

  constructor() {
    const issues = `${REPO_URL}/issues/new?title=${encodeURIComponent('Data error: ')}`;
    const a = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
    this.el = h(
      'dialog.modal.panel.bracket',
      { 'aria-labelledby': 'about-title' },
      h(
        'div.modal-inner',
        null,
        h('span.eyebrow', null, 'About & method'),
        h('h2', { id: 'about-title' }, 'How EXPOSE works'),
        h(
          'p',
          null,
          'EXPOSE is an open map of documented relationships between powerful people, companies, investment funds, political parties, governments, media outlets and other organisations. It shows who owns, runs, founded, funded or politically works with whom — and why, with the sources to check it yourself.',
        ),
        h('h3', null, 'Where the data comes from'),
        h(
          'ul',
          null,
          h('li', null, a('https://www.wikidata.org/', 'Wikidata'), ': ownership, leadership, founder, investor and political-office statements. Rows are marked “via Wikidata”.'),
          h('li', null, a('https://www.wikipedia.org/', 'Wikipedia'), ': descriptions, places and the cited articles behind curated connections.'),
          h('li', null, a('https://www.gleif.org/', 'GLEIF'), ' (Legal Entity Identifier data): corporate parent / subsidiary relations. Marked “via GLEIF”.'),
          h('li', null, a('https://littlesis.org/', 'LittleSis'), ': board seats, positions, donations and memberships researched by the LittleSis community. Marked “via LittleSis”.'),
          h('li', null, 'Curated entries written by hand, each citing at least one public source (official filings such as SEC EDGAR, reputable reporting).'),
          h('li', null, 'The dataset is rebuilt automatically every week; the generation date is shown at the bottom of the dossier.'),
        ),
        h('h3', null, 'Influence and marker size'),
        h(
          'p',
          null,
          'Each entity has an influence score from 0 to 100, computed by the data pipeline from notability, wealth or size, and connectedness in this graph — an approximation, not a judgement. It sets the marker size on the globe (the marker area grows with the score) and the order of labels and lists. Where the data has no score yet, it is estimated from the number of connections and marked “est.”.',
        ),
        h('h3', null, 'Marker symbols'),
        h(
          'ul.kind-legend',
          null,
          KINDS.map((k) => h('li', null, KindIcon(k.id, 12), k.label)),
        ),
        h(
          'p',
          null,
          'Use the “Entity type” and “Connection type” filters to show or hide any of them — double-click or long-press a chip to show only that one.',
        ),
        h('h3', null, 'What a connection means'),
        h(
          'p',
          null,
          'A connection is a documented relationship — a role, a stake, an investment, a political office or affiliation. It is not an accusation of wrongdoing, and the absence of a connection proves nothing. Ended relationships are marked as past.',
        ),
        h('h3', null, 'Found an error?'),
        h(
          'p',
          null,
          'Please ',
          a(issues, 'open an issue on GitHub'),
          ' with the entity, what is wrong and a public source showing the correct information. Every dossier has a pre-filled “Report an error” link.',
        ),
        h('h3', null, 'Licences'),
        h(
          'p',
          null,
          'Wikidata content and GLEIF LEI data are available under ',
          a('https://creativecommons.org/publicdomain/zero/1.0/', 'CC0'),
          '. Data from LittleSis is licensed under ',
          a('https://creativecommons.org/licenses/by-sa/4.0/', 'CC BY-SA 4.0'),
          ' (© LittleSis contributors). Descriptions and images from Wikipedia and Wikimedia Commons are available under CC BY-SA 4.0 or their respective file licences. Map geometry: Natural Earth (public domain) via world-atlas. Source code: ',
          a(REPO_URL, 'GitHub'),
          '.',
        ),
      ),
      h(
        'button.icon-btn.bare.close',
        { type: 'button', 'aria-label': 'Close', onclick: () => this.close() },
        icon(ICONS.close, 16),
      ),
    );
    // click on the backdrop closes
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
  }

  open(): void {
    if (!this.el.open) this.el.showModal();
  }

  close(): void {
    this.el.close();
  }
}
