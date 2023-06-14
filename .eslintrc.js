module.exports = {
    "env": {
        "browser": true,
        "es2021": true
    },
  "extends": [
    "airbnb-base",
    "prettier"
  ],
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "project": "./tsconfig.json",
    "sourceType": "module"
    },
  "ignorePatterns": [".eslintrc.js"],
  "settings": {
   "import/extensions": [
      "error",
      "ignorePackages",
      {
        "js": "never",
        "jsx": "never",
        "ts": "never",
        "tsx": "never"
      }
   ],
    "import/parsers": {
      "@typescript-eslint/parser": [".ts", ".tsx"]
    },
    "import/resolver": {
      "typescript": {
        "directory": "./tsconfig.json"
      },
      "node": {
        "extensions": [".js", ".jsx", ".ts", ".tsx"]
      }
    },
    "react": {
        "version": "999.99.99"
    }
  },
  "rules": {
    "no-console": "off",
   "import/extensions": [
      "error",
      "ignorePackages",
      {
        "js": "never",
        "jsx": "never",
        "ts": "never",
        "tsx": "never"
      }
   ],
    "import/no-unresolved": [2, { "commonjs": true, "amd": true }],
    "import/named": 2,
    "import/namespace": 2,
    "import/default": 2,
    "import/export": 2,
    "import/prefer-default-export": "off",
    "indent": "off",
    "prettier/prettier": 2
  },
  "plugins": ["import", "prettier"]
}
