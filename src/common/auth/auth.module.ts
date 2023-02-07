import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuardWs } from './auth.guard';
import { ApiModule } from '@multiversx/sdk-nestjs';
import { NativeAuthModule } from '../nativeauth/nativeauth.module';
import { PersistenceModule } from '../persistence/persistence.module';

@Module({
  imports: [ApiModule, PersistenceModule.forRoot(), NativeAuthModule],
  providers: [AuthService, AuthGuardWs],
  exports: [AuthService, AuthGuardWs],
})
export class AuthModule { }
