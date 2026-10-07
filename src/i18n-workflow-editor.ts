/** The strings of the workflow editor (W6) and the graph's own labels it shares. Merged into the plugin dictionaries by i18n.ts. */
export const editorEn = {
  wfEditProblemsOn: "The validator found a problem here",
  wfNotes: "Notes on the graph",
  wfNoteEmpty: "Empty note",
};

export const editorRu: { [K in keyof typeof editorEn]: string } = {
  wfEditProblemsOn: "Валидатор нашёл здесь проблему",
  wfNotes: "Заметки к графу",
  wfNoteEmpty: "Пустая заметка",
};
