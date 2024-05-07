/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['dotenv/config', './jest.init.ts'],
  testPathIgnorePatterns: ['<rootDir>/dist'],
  moduleNameMapper: {
    '^#app/(.*)$': '<rootDir>/src/$1',
  },
};
