import { forwardRef, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AccountDetailed } from './entities/account.detailed';
import { Account } from './entities/account';
import { VmQueryService } from 'src/endpoints/vm.query/vm.query.service';
import { ApiConfigService } from 'src/common/api-config/api.config.service';
import { AccountDeferred } from './entities/account.deferred';
import { QueryPagination } from 'src/common/entities/query.pagination';
import { AccountKey } from './entities/account.key';
import { DeployedContract } from './entities/deployed.contract';
import { TransactionService } from '../transactions/transaction.service';
import { PluginService } from 'src/common/plugins/plugin.service';
import { AccountEsdtHistory } from "./entities/account.esdt.history";
import { AccountHistory } from "./entities/account.history";
import { StakeService } from '../stake/stake.service';
import { TransferService } from '../transfers/transfer.service';
import { SmartContractResultService } from '../sc-results/scresult.service';
import { TransactionType } from '../transactions/entities/transaction.type';
import { AssetsService } from 'src/common/assets/assets.service';
import { TransactionFilter } from '../transactions/entities/transaction.filter';
import { AddressUtils, ApiService, ApiUtils, BinaryUtils, CachingService } from '@multiversx/sdk-nestjs';
import { GatewayService } from 'src/common/gateway/gateway.service';
import { IndexerService } from "src/common/indexer/indexer.service";
import { AccountOptionalFieldOption } from './entities/account.optional.field.options';
import { AccountAssets } from 'src/common/assets/entities/account.assets';
import { OriginLogger } from '@multiversx/sdk-nestjs';
import { CacheInfo } from 'src/utils/cache.info';
import { UsernameService } from '../usernames/username.service';
import { ContractUpgrades } from './entities/contract.upgrades';
import { AccountVerification } from './entities/account.verification';

@Injectable()
export class AccountService {
  private readonly logger = new OriginLogger(AccountService.name);

  constructor(
    private readonly indexerService: IndexerService,
    private readonly gatewayService: GatewayService,
    private readonly cachingService: CachingService,
    private readonly vmQueryService: VmQueryService,
    private readonly apiConfigService: ApiConfigService,
    @Inject(forwardRef(() => TransactionService))
    private readonly transactionService: TransactionService,
    @Inject(forwardRef(() => PluginService))
    private readonly pluginService: PluginService,
    @Inject(forwardRef(() => StakeService))
    private readonly stakeService: StakeService,
    @Inject(forwardRef(() => TransferService))
    private readonly transferService: TransferService,
    @Inject(forwardRef(() => SmartContractResultService))
    private readonly smartContractResultService: SmartContractResultService,
    private readonly assetsService: AssetsService,
    private readonly usernameService: UsernameService,
    private readonly apiService: ApiService
  ) { }

  async getAccountsCount(): Promise<number> {
    return await this.cachingService.getOrSetCache(
      CacheInfo.AccountsCount.key,
      async () => await this.indexerService.getAccountsCount(),
      CacheInfo.AccountsCount.ttl
    );
  }

  async getAccount(address: string, fields?: string[]): Promise<AccountDetailed | null> {
    if (!AddressUtils.isAddressValid(address)) {
      return null;
    }

    let txCount: number = 0;
    let scrCount: number = 0;

    if (!fields || fields.length === 0 || fields.includes(AccountOptionalFieldOption.txCount)) {
      txCount = await this.getAccountTxCount(address);
    }

    if (!fields || fields.length === 0 || fields.includes(AccountOptionalFieldOption.scrCount)) {
      scrCount = await this.getAccountScResults(address);
    }

    return this.getAccountRaw(address, txCount, scrCount);
  }

  async getAccountVerification(address: string): Promise<AccountVerification | null> {
    if (!AddressUtils.isAddressValid(address)) {
      return null;
    }

    const verificationResponse = await this.apiService.get(`${this.apiConfigService.getVerifierUrl()}/verifier/${address}`);
    return verificationResponse.data;
  }

  async getAccountSimple(address: string): Promise<AccountDetailed | null> {
    if (!AddressUtils.isAddressValid(address)) {
      return null;
    }

    return await this.getAccountRaw(address);
  }

  async getAccountRaw(address: string, txCount: number = 0, scrCount: number = 0): Promise<AccountDetailed | null> {
    const assets = await this.assetsService.getAllAccountAssets();

    try {
      const {
        account: { nonce, balance, code, codeHash, rootHash, developerReward, ownerAddress, codeMetadata },
      } = await this.gatewayService.getAddressDetails(address);

      const shard = AddressUtils.computeShard(AddressUtils.bech32Decode(address));
      let account = new AccountDetailed({ address, nonce, balance, code, codeHash, rootHash, txCount, scrCount, shard, developerReward, ownerAddress, scamInfo: undefined, assets: assets[address], nftCollections: undefined, nfts: undefined });

      const codeAttributes = AddressUtils.decodeCodeMetadata(codeMetadata);
      if (codeAttributes) {
        account = { ...account, ...codeAttributes };
      }

      if (AddressUtils.isSmartContractAddress(address) && account.code) {
        const deployTxHash = await this.getAccountDeployedTxHash(address);
        if (deployTxHash) {
          account.deployTxHash = deployTxHash;
        }

        const deployedAt = await this.getAccountDeployedAt(address);
        if (deployedAt) {
          account.deployedAt = deployedAt;
        }

        const isVerified = await this.getAccountIsVerified(address, account.codeHash);
        if (isVerified) {
          account.isVerified = isVerified;
        }
      }

      if (!AddressUtils.isSmartContractAddress(address)) {
        account.username = await this.usernameService.getUsernameForAddress(address) ?? undefined;
      }

      await this.pluginService.processAccount(account);
      return account;
    } catch (error) {
      this.logger.error(error);
      this.logger.error(`Error when getting account details for address '${address}'`);
      return null;
    }
  }

  async getAccountTxCount(address: string): Promise<number> {
    if (!this.apiConfigService.getIsIndexerV3FlagActive()) {
      return this.transactionService.getTransactionCountForAddress(address);
    }

    return await this.transferService.getTransfersCount(new TransactionFilter({ address, type: TransactionType.Transaction }));
  }

  async getAccountScResults(address: string): Promise<number> {
    if (!this.apiConfigService.getIsIndexerV3FlagActive()) {
      return await this.smartContractResultService.getAccountScResultsCount(address);
    }

    return await this.transferService.getTransfersCount(new TransactionFilter({ address, type: TransactionType.SmartContractResult }));
  }

  async getAccountDeployedAt(address: string): Promise<number | null> {
    return await this.cachingService.getOrSetCache(
      CacheInfo.AccountDeployedAt(address).key,
      async () => await this.getAccountDeployedAtRaw(address),
      CacheInfo.AccountDeployedAt(address).ttl
    );
  }

  async getAccountDeployedAtRaw(address: string): Promise<number | null> {
    const scDeploy = await this.indexerService.getScDeploy(address);
    if (!scDeploy) {
      return null;
    }

    const txHash = scDeploy.deployTxHash;
    if (!txHash) {
      return null;
    }

    const transaction = await this.indexerService.getTransaction(txHash);
    if (!transaction) {
      return null;
    }

    return transaction.timestamp;
  }

  async getAccountDeployedTxHash(address: string): Promise<string | null> {
    return await this.cachingService.getOrSetCache(
      CacheInfo.AccountDeployTxHash(address).key,
      async () => await this.getAccountDeployedTxHashRaw(address),
      CacheInfo.AccountDeployTxHash(address).ttl,
    );
  }

  async getAccountDeployedTxHashRaw(address: string): Promise<string | null> {
    const scDeploy = await this.indexerService.getScDeploy(address);
    if (!scDeploy) {
      return null;
    }

    return scDeploy.deployTxHash;
  }

  async getAccountIsVerified(address: string, codeHash: string): Promise<boolean | null> {
    return await this.cachingService.getOrSetCache(
      CacheInfo.AccountIsVerified(address).key,
      async () => await this.getAccountIsVerifiedRaw(address, codeHash),
      CacheInfo.AccountIsVerified(address).ttl
    );
  }

  async getAccountIsVerifiedRaw(address: string, codeHash: string): Promise<boolean | null> {
    try {
      // eslint-disable-next-line require-await
      const { data } = await this.apiService.get(`${this.apiConfigService.getVerifierUrl()}/verifier/${address}/codehash`, undefined, async (error) => error.response?.status === HttpStatus.NOT_FOUND);

      if (data.codeHash === Buffer.from(codeHash, 'base64').toString('hex')) {
        return true;
      }
    } catch {
      // ignore
    }

    return null;
  }

  async getAccounts(queryPagination: QueryPagination): Promise<Account[]> {
    return await this.cachingService.getOrSetCache(
      CacheInfo.Accounts(queryPagination).key,
      async () => await this.getAccountsRaw(queryPagination),
      CacheInfo.Accounts(queryPagination).ttl
    );
  }

  public async getAccountsForAddresses(addresses: Array<string>): Promise<Array<Account>> {
    const assets: { [key: string]: AccountAssets; } = await this.assetsService.getAllAccountAssets();

    const accountsRaw = await this.indexerService.getAccountsForAddresses(addresses);
    const accounts: Array<Account> = accountsRaw.map(account => ApiUtils.mergeObjects(new Account(), account));

    for (const account of accounts) {
      account.shard = AddressUtils.computeShard(AddressUtils.bech32Decode(account.address));
      account.assets = assets[account.address];
    }

    return accounts;
  }

  async getAccountsRaw(queryPagination: QueryPagination): Promise<Account[]> {
    const result = await this.indexerService.getAccounts(queryPagination);

    const assets = await this.assetsService.getAllAccountAssets();

    const accounts: Account[] = result.map(item => ApiUtils.mergeObjects(new Account(), item));
    for (const account of accounts) {
      account.shard = AddressUtils.computeShard(AddressUtils.bech32Decode(account.address));
      account.assets = assets[account.address];
    }

    return accounts;
  }

  async getDeferredAccount(address: string): Promise<AccountDeferred[]> {
    const publicKey = AddressUtils.bech32Decode(address);

    const [
      encodedUserDeferredPaymentList,
      [encodedNumBlocksBeforeUnBond],
      {
        erd_nonce,
      },
    ] = await Promise.all([
      this.vmQueryService.vmQuery(
        this.apiConfigService.getDelegationContractAddress(),
        'getUserDeferredPaymentList',
        undefined,
        [publicKey]
      ),
      this.vmQueryService.vmQuery(
        this.apiConfigService.getDelegationContractAddress(),
        'getNumBlocksBeforeUnBond',
      ),
      this.gatewayService.getNetworkStatus(`${this.apiConfigService.getDelegationContractShardId()}`),
    ]);

    const numBlocksBeforeUnBond = parseInt(BinaryUtils.base64ToBigInt(encodedNumBlocksBeforeUnBond).toString());
    const erdNonce = erd_nonce;

    const data: AccountDeferred[] = encodedUserDeferredPaymentList.reduce((result: AccountDeferred[], _, index, array) => {
      if (index % 2 === 0) {
        const [encodedDeferredPayment, encodedUnstakedNonce] = array.slice(index, index + 2);

        const deferredPayment = BinaryUtils.base64ToBigInt(encodedDeferredPayment).toString();
        const unstakedNonce = parseInt(BinaryUtils.base64ToBigInt(encodedUnstakedNonce).toString());
        const blocksLeft = Math.max(0, unstakedNonce + numBlocksBeforeUnBond - erdNonce);
        const secondsLeft = blocksLeft * 6; // 6 seconds per block

        result.push({ deferredPayment, secondsLeft });
      }

      return result;
    }, []);

    return data;
  }

  private async getBlsKeysStatusForPublicKey(publicKey: string) {
    return await this.vmQueryService.vmQuery(
      this.apiConfigService.getAuctionContractAddress(),
      'getBlsKeysStatus',
      this.apiConfigService.getAuctionContractAddress(),
      [publicKey],
    );
  }

  private async getRewardAddressForNode(blsKey: string): Promise<string> {
    const [encodedRewardsPublicKey] = await this.vmQueryService.vmQuery(
      this.apiConfigService.getStakingContractAddress(),
      'getRewardAddress',
      undefined,
      [blsKey],
    );

    const rewardsPublicKey = Buffer.from(encodedRewardsPublicKey, 'base64').toString();
    return AddressUtils.bech32Encode(rewardsPublicKey);
  }

  async getKeys(address: string): Promise<AccountKey[]> {
    const publicKey = AddressUtils.bech32Decode(address);

    const blsKeysStatus = await this.getBlsKeysStatusForPublicKey(publicKey);
    if (!blsKeysStatus) {
      return [];
    }

    const nodes: AccountKey[] = [];
    for (let index = 0; index < blsKeysStatus.length; index += 2) {
      const [encodedBlsKey, encodedStatus] = blsKeysStatus.slice(index, index + 2);

      const accountKey: AccountKey = new AccountKey;
      accountKey.blsKey = BinaryUtils.padHex(Buffer.from(encodedBlsKey, 'base64').toString('hex'));
      accountKey.status = Buffer.from(encodedStatus, 'base64').toString();
      accountKey.stake = '2500000000000000000000';

      nodes.push(accountKey);
    }

    if (nodes.length) {
      const rewardAddress = await this.getRewardAddressForNode(nodes[0].blsKey);
      const { topUp } = await this.stakeService.getAllStakesForNode(address);

      for (const node of nodes) {
        node.rewardAddress = rewardAddress;
        node.topUp = topUp;
      }
    }

    const queuedNodes: string[] = nodes
      .filter((node: AccountKey) => node.status === 'queued')
      .map(({ blsKey }) => blsKey);

    if (queuedNodes.length) {
      const [queueSizeEncoded] = await this.vmQueryService.vmQuery(
        this.apiConfigService.getStakingContractAddress(),
        'getQueueSize',
      );

      if (queueSizeEncoded) {
        const queueSize = Buffer.from(queueSizeEncoded, 'base64').toString();

        const queueIndexes = await Promise.all([
          ...queuedNodes.map((blsKey: string) =>
            this.vmQueryService.vmQuery(
              this.apiConfigService.getStakingContractAddress(),
              'getQueueIndex',
              this.apiConfigService.getAuctionContractAddress(),
              [blsKey],
            )
          ),
        ]);

        let index = 0;
        for (const queueIndexEncoded of queueIndexes) {
          if (queueIndexEncoded) {
            const [found] = nodes.filter((x: AccountKey) => x.blsKey === queuedNodes[index]);

            found.queueIndex = Buffer.from(queueIndexEncoded[0], 'base64').toString();
            found.queueSize = queueSize;

            index++;
          }
        }
      }
    }

    return nodes;
  }

  async getAccountContracts(pagination: QueryPagination, address: string): Promise<DeployedContract[]> {
    const accountDeployedContracts = await this.indexerService.getAccountContracts(pagination, address);
    const assets = await this.assetsService.getAllAccountAssets();

    const accounts: DeployedContract[] = accountDeployedContracts.map(contract => ({
      address: contract.contract,
      deployTxHash: contract.deployTxHash,
      timestamp: contract.timestamp,
      assets: assets[contract.contract],
    }));

    return accounts;
  }

  async getAccountContractsCount(address: string): Promise<number> {
    return await this.indexerService.getAccountContractsCount(address);
  }

  async getContractUpgrades(queryPagination: QueryPagination, address: string): Promise<ContractUpgrades[] | null> {
    const details = await this.indexerService.getScDeploy(address);
    if (!details) {
      return null;
    }

    const upgrades = details.upgrades.map(item => ApiUtils.mergeObjects(new ContractUpgrades(), {
      address: item.upgrader,
      txHash: item.upgradeTxHash,
      timestamp: item.timestamp,
    }));

    return upgrades.slice(queryPagination.from, queryPagination.from + queryPagination.size);
  }

  async getAccountHistory(address: string, pagination: QueryPagination): Promise<AccountHistory[]> {
    const elasticResult = await this.indexerService.getAccountHistory(address, pagination);
    return elasticResult.map(item => ApiUtils.mergeObjects(new AccountHistory(), item));
  }

  async getAccountTokenHistory(address: string, tokenIdentifier: string, pagination: QueryPagination): Promise<AccountEsdtHistory[]> {
    const elasticResult = await this.indexerService.getAccountTokenHistory(address, tokenIdentifier, pagination);
    return elasticResult.map(item => ApiUtils.mergeObjects(new AccountEsdtHistory(), item));
  }
}
