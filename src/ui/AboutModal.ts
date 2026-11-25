import { REPO_URL } from '../config';
import { h, icon, ICONS } from '../dom';

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
          'EXPOSE is an open map of documented relationships between powerful people, companies, investment funds and governments. It shows who owns, runs, founded, funded or politically works with whom — and why, with the sources to check it yourself.',
        ),
        h('h3', null, 'Where the data comes from'),
        h(
          'ul',
          null,
          h('li', null, 'Automatic import from ', a('https://www.wikidata.org/', 'Wikidata'), ': ownership, leadership, founder, investor and political-office statements for a curated list of entities. These rows are marked “via Wikidata”.'),
          h('li', null, 'Curated entries written by hand, each citing at least one public source (Wikipedia, official filings, reputable reporting).'),
          h('li', null, 'The dataset is rebuilt automatically every week; the generation date is shown at the bottom of the dossier.'),
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
          'Wikidata content is available under ',
          a('https://creativecommons.org/publicdomain/zero/1.0/', 'CC0'),
          '. Descriptions and images from Wikipedia and Wikimedia Commons are available under ',
          a('https://creativecommons.org/licenses/by-sa/4.0/', 'CC BY-SA 4.0'),
          ' or their respective file licences. Source code: ',
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
