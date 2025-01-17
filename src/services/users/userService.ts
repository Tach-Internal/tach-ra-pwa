import bcrypt from 'bcryptjs';
import { IUserAddressService, IUserService } from '@/abstractions';
import {
  ICommandRepository,
  IEmailService,
  IIdOmitter,
  IMapper,
  IProvider,
  IQueryRepository,
  ITokenService,
} from '@/lib/abstractions';
import { ErrorWithStatusCode } from '@/lib/errors';
import {
  AccountDto,
  IUser,
  IUserAddress,
  IUserRolesEnum,
  UserDto,
} from '@/models';

import '@/mappingProfiles/services/users/mappingProfile';
import { Injectable } from '@/lib/ioc/injectable';

@Injectable(
  'userService',
  'userQueryRepository',
  'userCommandRepository',
  'accountQueryRepository',
  'accountCommandRepository',
  'userAddressService',
  'automapperProvider',
  'emailService',
  'tokenService',
  'idOmitter',
  'tachEmailSource',
  'nextPublicBaseUrl',
)
export class UserService implements IUserService {
  private _userQueryRepository: IQueryRepository<UserDto>;

  private _userCommandRepository: ICommandRepository<UserDto>;

  private _accountQueryRepository: IQueryRepository<AccountDto>;

  private _accountCommandRepository: ICommandRepository<AccountDto>;

  private _userAddressService: IUserAddressService;

  private _automapperProvider: IProvider<IMapper>;

  private _emailService: IEmailService;

  private _tokenService: ITokenService;

  private _idOmitter: IIdOmitter;

  private _fromEmail: string;

  private _baseUrl: string;

  constructor(
    userQueryRepository: IQueryRepository<UserDto>,
    userCommandRepository: ICommandRepository<UserDto>,
    accountQueryRepository: IQueryRepository<AccountDto>,
    accountCommandRepository: ICommandRepository<AccountDto>,
    userAddressService: IUserAddressService,
    automapperProvider: IProvider<IMapper>,
    emailService: IEmailService,
    tokenService: ITokenService,
    idOmitter: IIdOmitter,
    tachEmailSource: string,
    nextPublicBaseUrl: string,
  ) {
    this._fromEmail = tachEmailSource;
    this._baseUrl = nextPublicBaseUrl;
    this._userQueryRepository = userQueryRepository;
    this._userCommandRepository = userCommandRepository;
    this._accountQueryRepository = accountQueryRepository;
    this._accountCommandRepository = accountCommandRepository;
    this._userAddressService = userAddressService;
    this._automapperProvider = automapperProvider;
    this._emailService = emailService;
    this._tokenService = tokenService;
    this._idOmitter = idOmitter;
  }

  async createUser(user: IUser, password: string): Promise<IUser> {
    const encryptedPassword = await bcrypt.hash(password, 10);

    const mapper = this._automapperProvider.provide();
    const userDto = mapper.map<IUser, UserDto>(user, 'IUser', 'UserDto', {
      extraArgs: () => ({ password: encryptedPassword }),
    });

    const createdUserId = await this._userCommandRepository.create(userDto);

    if (!createdUserId) {
      throw new ErrorWithStatusCode(
        'Unable to create user.',
        500,
        'There is an issue with the server. Please try again later.',
      );
    }

    const createdAccountId = await this._accountCommandRepository.create({
      userId: createdUserId,
      type: 'credentials',
      provider: 'credentials',
      providerAccountId: createdUserId,
    });

    if (!createdAccountId) {
      throw new ErrorWithStatusCode(
        `Unable to create user account with user id '${createdUserId}'.`,
        500,
        'There is an issue with the server. Please try again later.',
      );
    }

    const token = await this._tokenService.createToken(
      createdUserId,
      user.email,
      '14d',
    );

    let createdUser = (await this._userQueryRepository.getById(
      createdUserId,
    )) as UserDto;

    createdUser.token = token;
    createdUser = this._idOmitter.omitId(createdUser);

    await this._userCommandRepository.update(createdUserId, createdUser);

    await this._emailService.sendEmail(
      this._fromEmail,
      user.email,
      '[Action Required] Welcome to Tach Color Store!',
      `Please verify your email address by clicking this link: <a href="${this._baseUrl}/auth/verifyEmail?token=${token}" target="_blank">Verify Email</a>`,
    );

    return mapper.map<UserDto, IUser>(createdUser, 'UserDto', 'IUser');
  }

  async resendEmailAddressVerification(token: string): Promise<void> {
    const users = await this._userQueryRepository.find({
      token,
    });

    if (users.length === 0) {
      throw new ErrorWithStatusCode(
        'The provided token was not found.',
        400,
        'Bad request.',
      );
    }

    const user = users[0];

    const newToken = await this._tokenService.createToken(
      user._id,
      user.email,
      '14d',
    );

    await this._userCommandRepository.update(user._id, { token: newToken });

    await this._emailService.sendEmail(
      this._fromEmail,
      user.email,
      '[Action Required] Welcome to Tach Color Store!',
      `Please verify your email address by clicking this link: <a href="${this._baseUrl}/auth/verifyEmail?token=${newToken}" target="_blank">Verify Email</a>`,
    );
  }

  async sendPasswordResetRequest(email: string): Promise<void> {
    const users = await this._userQueryRepository.find({ email });

    if (users.length === 0) {
      throw new ErrorWithStatusCode(
        'The provided email was not found.',
        400,
        'Bad request.',
      );
    }

    const user = users[0];

    const accounts = await this._accountQueryRepository.find({
      userId: user._id,
    });

    if (accounts.length === 0) {
      throw new ErrorWithStatusCode(
        `The user account for user id '${user._id}' was not found.`,
        500,
        'There was an error on the server. Please try again later.',
      );
    }

    const account = accounts[0];

    if (account.provider !== 'credentials') {
      throw new ErrorWithStatusCode(
        'The provided email is associated with an account managed with a third-party OAuth Provider; there is no password to reset.',
        400,
        'Bad request.',
      );
    }

    const token = await this._tokenService.createToken(
      user._id,
      user.email,
      '30m',
    );

    await this._userCommandRepository.update(user._id, {
      passwordResetToken: token,
    });

    await this._emailService.sendEmail(
      this._fromEmail,
      user.email,
      '[Action Required] Tach Color Store password reset request',
      `A request was made to reset the password for the account associated with this email. If you did not make this request, please disregard this email. This link expires after 30 minutes. <a href="${
        this._baseUrl
      }/auth/resetPassword/verify?passwordResetToken=${token}&email=${encodeURIComponent(
        email,
      )}" target="_blank">Reset Password</a>`,
    );
  }

  async resetPassword(
    email: string,
    token: string,
    password: string,
    confirmPassword: string,
  ): Promise<void> {
    const users = await this._userQueryRepository.find({ email });

    if (users.length === 0) {
      throw new ErrorWithStatusCode(
        'The provided email was not found.',
        400,
        'Bad request.',
      );
    }

    const user = users[0];

    const accounts = await this._accountQueryRepository.find({
      userId: user._id,
    });

    if (accounts.length === 0) {
      throw new ErrorWithStatusCode(
        `The user account for user id '${user._id}' was not found.`,
        500,
        'There was an error on the server. Please try again later.',
      );
    }

    const account = accounts[0];

    if (account.provider !== 'credentials') {
      throw new ErrorWithStatusCode(
        'The provided email is associated with an account managed with a third-party OAuth Provider; there is no password to reset.',
        400,
        'Bad request.',
      );
    }

    const isValid = await this._tokenService.validateToken(token, email);

    if (!isValid) {
      throw new ErrorWithStatusCode('Token is invalid.', 400);
    }

    if (password !== confirmPassword) {
      throw new ErrorWithStatusCode('Passwords do not match.', 400);
    }

    const encryptedPassword = await bcrypt.hash(password, 10);

    await this._userCommandRepository.update(user._id, {
      password: encryptedPassword,
    });

    await this._emailService.sendEmail(
      this._fromEmail,
      user.email,
      'Tach Color Store password reset successful',
      `Your password has been successfully reset. You can now login with your new password.`,
    );
  }

  async verifyEmailAddress(token: string): Promise<void> {
    const users = await this._userQueryRepository.find({ token });

    if (users.length === 0) {
      throw new ErrorWithStatusCode(
        'The provided token was not found.',
        400,
        'The provided token was not found.',
      );
    }

    const user = users[0];

    const isValid = await this._tokenService.validateToken(token, user.email);

    if (!isValid) {
      throw new ErrorWithStatusCode('Token is invalid.', 400);
    }

    await this._userCommandRepository.update(user._id, {
      emailVerified: new Date(Date.now()),
    });
  }

  async setUserRoles(
    userId: string,
    roles: Extract<keyof IUserRolesEnum, string>[],
  ): Promise<IUser> {
    const userDto = await this._userQueryRepository.getById(userId);

    if (!userDto) {
      throw new ErrorWithStatusCode(
        `User with id '${userId}' not found.`,
        404,
        'User not found.',
      );
    }

    await this._userCommandRepository.update(userId, { roles });

    return this.getUserById(userId);
  }

  async getUserById(userId: string): Promise<IUser> {
    const userDto = await this._userQueryRepository.getById(userId);

    if (!userDto) {
      throw new ErrorWithStatusCode(
        `User with id '${userId}' not found.`,
        404,
        'User not found.',
      );
    }

    const userAddresses = await this._userAddressService.getAllUserAddresses(
      userId,
    );

    const mapper = this._automapperProvider.provide();
    return mapper.map<UserDto, IUser>(userDto, 'UserDto', 'IUser', {
      extraArgs: () => ({ userAddresses }),
    });
  }

  async getAllUsers(): Promise<IUser[]> {
    const userDtos = await this._userQueryRepository.list();

    const userAddressPromises: Promise<IUserAddress[]>[] = [];
    for (let i = 0; i < userDtos.length; i++) {
      userAddressPromises.push(
        this._userAddressService.getAllUserAddresses(userDtos[i]._id),
      );
    }
    const userAddresses = await Promise.all(userAddressPromises);

    const mapper = this._automapperProvider.provide();

    const users: IUser[] = [];
    for (let i = 0; i < userDtos.length; i++) {
      users.push(
        mapper.map<UserDto, IUser>(userDtos[i], 'UserDto', 'IUser', {
          extraArgs: () => ({ userAddresses: userAddresses[i] }),
        }),
      );
    }

    return users;
  }
}
