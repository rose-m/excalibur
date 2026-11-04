export class ServiceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
