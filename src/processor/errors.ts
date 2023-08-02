export class GetUserGraphError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "GetUserGraphError";
    }
}
  
export class ApplyActionsError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ApplyActionsError";
    }
}
  
export class CapacityLowError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CapacityLowError";
    }
}

export class StaleHashError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "StaleHashError";
    }
}

export class UnknownError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "UnknownError";
    }
}
