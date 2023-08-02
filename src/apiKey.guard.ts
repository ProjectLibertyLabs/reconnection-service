import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'];

    // Validate the API key
    if (apiKey !== process.env.SECRET_API_KEY) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
