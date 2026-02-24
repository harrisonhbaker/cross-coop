// Collection of crossword puzzles
// Each puzzle: size (columns), solution (2D array, null = black square)
// Every row MUST have exactly `size` elements.

const puzzles = [
  {
    id: "puzzle-1",
    title: "Dev Lingo",
    size: 7,
    solution: [
      ["C","O","D","E",null,null,null],
      ["A","R","R","A","Y",null,null],
      ["C",null,null,null,null,null,null],
      ["H","T","M","L",null,null,null],
      ["E",null,null,null,"G","I","T"],
      [null,null,null,null,null,null,null],
      [null,"B","U","G",null,null,null],
    ],
    clues: {
      across: [
        { number: 1, row: 0, col: 0, text: "Write lines of this to build software", length: 4 },
        { number: 2, row: 1, col: 0, text: "Indexed collection of elements", length: 5 },
        { number: 4, row: 3, col: 0, text: "Web page markup language", length: 4 },
        { number: 5, row: 4, col: 4, text: "Version control tool by Torvalds", length: 3 },
        { number: 6, row: 6, col: 1, text: "A flaw in your program", length: 3 },
      ],
      down: [
        { number: 1, row: 0, col: 0, text: "Stored data for faster retrieval", length: 5 },
      ],
    },
  },
  {
    id: "puzzle-2",
    title: "Full Stack",
    size: 9,
    solution: [
      ["R","E","A","C","T",null,null,null,null],
      ["U",null,"P",null,null,null,null,null,null],
      ["S",null,"I",null,null,null,null,null,null],
      ["T",null,null,null,null,null,null,null,null],
      [null,"L","O","O","P",null,"S",null,null],
      [null,null,null,null,null,null,"Q",null,null],
      ["N","O","D","E",null,null,"L",null,null],
      [null,null,null,null,null,null,null,null,null],
      ["C","S","S",null,"B","U","G",null,null],
    ],
    clues: {
      across: [
        { number: 1, row: 0, col: 0, text: "Meta's JavaScript UI library", length: 5 },
        { number: 3, row: 4, col: 1, text: "for / while ___: repeating code", length: 4 },
        { number: 5, row: 6, col: 0, text: "Server-side JavaScript runtime", length: 4 },
        { number: 6, row: 8, col: 0, text: "Stylesheet language for the web", length: 3 },
        { number: 7, row: 8, col: 4, text: "A software defect", length: 3 },
      ],
      down: [
        { number: 1, row: 0, col: 0, text: "Mozilla's memory-safe systems language", length: 4 },
        { number: 2, row: 0, col: 2, text: "Application Programming Interface", length: 3 },
        { number: 4, row: 4, col: 6, text: "Structured Query Language", length: 3 },
      ],
    },
  },
];

module.exports = puzzles;
