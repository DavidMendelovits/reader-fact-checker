// Self-check for the HTML-to-chapters extraction. Run it with:
//
//   node --experimental-strip-types src/html.check.ts
//
// Reader's html_content is what the narrator reads aloud and what the agent
// jumps around in by chapter name. A chapter that loses its heading can't be
// jumped to; a heading that doesn't split leaves the whole book in one lump;
// a stray <script> or <figure> gets read out as prose. Every case here is a
// shape Reader actually hands back.
import assert from 'node:assert/strict'
import { htmlToChapters, htmlToParagraphs } from './html.ts'

// ---- paragraphs ----

assert.deepEqual(htmlToParagraphs('<p>One.</p><p>Two.</p>'), ['One.', 'Two.'])
assert.deepEqual(htmlToParagraphs(''), [])

// scripts, styles, figures and chrome are dropped, not read aloud
assert.deepEqual(
  htmlToParagraphs(
    '<nav><a href="/">Home</a></nav><script>var x = 1;</script><style>p { color: red }</style>' +
      '<p>Body text.</p><figure><img src="x.png"><figcaption>A caption.</figcaption></figure>' +
      '<!-- a comment --><footer>Copyright</footer>',
  ),
  ['Body text.'],
)

// entities are decoded, named and numeric
assert.deepEqual(
  htmlToParagraphs('<p>Tom &amp; Jerry &ldquo;said&rdquo; &#8212; &#x2019;tis&nbsp;so</p>'),
  ['Tom & Jerry “said” — ’tis so'],
)

// <br> splits a paragraph; whitespace inside one is squashed
assert.deepEqual(htmlToParagraphs('<p>First line<br>Second line<br/>Third</p>'), ['First line', 'Second line', 'Third'])
assert.deepEqual(htmlToParagraphs('<p>\n  Spread   over\n\tlines  </p>'), ['Spread over lines'])

// inline tags become spaces, not glued words; single-char fragments are dropped
assert.deepEqual(htmlToParagraphs('<p>Some <em>emphasis</em> here.</p><p>x</p>'), ['Some emphasis here.'])

// lists, blockquotes and divs are paragraph boundaries too
assert.deepEqual(htmlToParagraphs('<ul><li>Alpha</li><li>Beta</li></ul><blockquote>Quoted</blockquote><div>Boxed</div>'), [
  'Alpha',
  'Beta',
  'Quoted',
  'Boxed',
])

// ---- chapters ----

// no headings: one chapter named after the document
assert.deepEqual(htmlToChapters('<p>Only text.</p><p>More.</p>', 'My Doc'), [
  { title: 'My Doc', paragraphs: ['Only text.', 'More.'] },
])

// nothing readable at all: still one (empty) chapter so the reader has somewhere to stand
assert.deepEqual(htmlToChapters('', 'Empty'), [{ title: 'Empty', paragraphs: [] }])
assert.deepEqual(htmlToChapters('<script>x()</script>', 'Empty'), [{ title: 'Empty', paragraphs: [] }])

// text before the first heading is a chapter titled after the document, with no title paragraph
{
  const chapters = htmlToChapters('<p>Preface text.</p><h1>Chapter One</h1><p>Body.</p>', 'The Book')
  assert.deepEqual(chapters, [
    { title: 'The Book', paragraphs: ['Preface text.'] },
    { title: 'Chapter One', paragraphs: ['Chapter One', 'Body.'] },
  ])
}

// each h1/h2/h3 starts a chapter titled by the heading; the heading is its first paragraph
{
  const chapters = htmlToChapters(
    '<h1>Part I</h1><p>A.</p><h2>Section 1</h2><p>B.</p><h3 class="x">Sub 1.1</h3><p>C.</p>',
    'The Book',
  )
  assert.deepEqual(chapters, [
    { title: 'Part I', paragraphs: ['Part I', 'A.'] },
    { title: 'Section 1', paragraphs: ['Section 1', 'B.'] },
    { title: 'Sub 1.1', paragraphs: ['Sub 1.1', 'C.'] },
  ])
}

// a document that starts with a heading has no preface chapter, and the first chapter keeps its title paragraph
{
  const chapters = htmlToChapters('<h1>Intro</h1><p>Hello.</p><h2>Next</h2><p>World.</p>', 'Doc')
  assert.deepEqual(chapters, [
    { title: 'Intro', paragraphs: ['Intro', 'Hello.'] },
    { title: 'Next', paragraphs: ['Next', 'World.'] },
  ])
}

// h4 and deeper are sub-sections: they stay inside the chapter as ordinary paragraphs
{
  const chapters = htmlToChapters('<h2>Ch</h2><p>A.</p><h4>Minor</h4><p>B.</p><h5>Tiny</h5><p>C.</p>', 'Doc')
  assert.deepEqual(chapters, [{ title: 'Ch', paragraphs: ['Ch', 'A.', 'Minor', 'B.', 'Tiny', 'C.'] }])
}

// heading text: inline markup stripped, entities decoded, whitespace squashed
{
  const chapters = htmlToChapters('<h1>\n  The <em>Old</em> Man &amp;\n the Sea </h1><p>Text.</p>', 'Doc')
  assert.deepEqual(chapters, [{ title: 'The Old Man & the Sea', paragraphs: ['The Old Man & the Sea', 'Text.'] }])
}

// a heading that is already repeated as the first paragraph is not doubled
{
  const chapters = htmlToChapters('<h1>Same</h1><p>Same</p><p>Body.</p>', 'Doc')
  assert.deepEqual(chapters, [{ title: 'Same', paragraphs: ['Same', 'Body.'] }])
}

// a document that is only headings: one chapter per heading, each just its title
{
  const chapters = htmlToChapters('<h1>One</h1><h2>Two</h2><h3>Three</h3>', 'Doc')
  assert.deepEqual(chapters, [
    { title: 'One', paragraphs: ['One'] },
    { title: 'Two', paragraphs: ['Two'] },
    { title: 'Three', paragraphs: ['Three'] },
  ])
}

// empty chapters are dropped: whitespace-only preface, and a heading with nothing but a figure after it
{
  const chapters = htmlToChapters('  \n <h1>A</h1><figure><img src="a.png"></figure><h1>B</h1><p>Text.</p>', 'Doc')
  assert.deepEqual(chapters, [
    { title: 'A', paragraphs: ['A'] },
    { title: 'B', paragraphs: ['B', 'Text.'] },
  ])
}

// an empty heading (<h2></h2>) doesn't rename the chapter: the previous title carries on
{
  const chapters = htmlToChapters('<h1>Real</h1><p>A.</p><h2> </h2><p>B.</p>', 'Doc')
  assert.deepEqual(chapters, [
    { title: 'Real', paragraphs: ['Real', 'A.'] },
    { title: 'Real', paragraphs: ['Real', 'B.'] },
  ])
}

// scripts inside a chapter body are dropped, and a script that contains a heading tag doesn't split
{
  const chapters = htmlToChapters('<h1>Ch</h1><p>A.</p><script>var s = "<h2>fake</h2>";</script><p>B.</p>', 'Doc')
  assert.deepEqual(chapters, [{ title: 'Ch', paragraphs: ['Ch', 'A.', 'B.'] }])
}

// the whole document's text is present exactly once across the chapters
{
  const html = '<p>Pre.</p><h1>One</h1><p>A.</p><p>B.</p><h2>Two</h2><p>C.</p>'
  const all = htmlToChapters(html, 'Doc').flatMap((c) => c.paragraphs)
  assert.deepEqual(all, ['Pre.', 'One', 'A.', 'B.', 'Two', 'C.'])
}

console.log('html.check: ok')
