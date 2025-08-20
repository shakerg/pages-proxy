module.exports = {
  "env": {
    "node": true,
    "commonjs": true,
    "es2021": true
  },
  "extends": "eslint:recommended",
  "parserOptions": {
    "ecmaVersion": 12
  },
  "rules": {
    "indent": [
      "error",
      2
    ],
    "linebreak-style": [
      "error",
      "unix"
    ],
    "quotes": [
      "error",
      "single",
      { "avoidEscape": true }
    ],
    "semi": [
      "error",
      "always"
    ],
    "no-unused-vars": [
      "warn",
      { 
        "args": "none",
        "varsIgnorePattern": "^_"
      }
    ],
    "no-console": "off",
    "curly": ["error", "all"],
    "eqeqeq": ["error", "always"],
    "no-eval": "error",
    "no-var": "error",
    "prefer-const": "error",
    "max-len": [
      "warn",
      {
        "code": 100,
        "ignoreComments": true,
        "ignoreStrings": true,
        "ignoreTemplateLiterals": true,
        "ignoreRegExpLiterals": true
      }
    ]
  }
};