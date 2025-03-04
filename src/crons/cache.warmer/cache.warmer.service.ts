import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { Cron, CronExpression, SchedulerRegistry } from "@nestjs/schedule";
import { IdentitiesService } from "src/endpoints/identities/identities.service";
import { NodeService } from "src/endpoints/nodes/node.service";
import { ProviderService } from "src/endpoints/providers/provider.service";
import { ClientProxy } from "@nestjs/microservices";
import { ApiConfigService } from "src/common/api-config/api.config.service";
import { NetworkService } from "src/endpoints/network/network.service";
import { AccountService } from "src/endpoints/accounts/account.service";
import { CronJob } from "cron";
import { KeybaseService } from "src/common/keybase/keybase.service";
import { GatewayService } from "src/common/gateway/gateway.service";
import { EsdtService } from "src/endpoints/esdt/esdt.service";
import { CacheInfo } from "src/utils/cache.info";
import { AssetsService } from "src/common/assets/assets.service";
import { GatewayComponentRequest } from "src/common/gateway/entities/gateway.component.request";
import { MexSettingsService } from "src/endpoints/mex/mex.settings.service";
import { MexPairService } from "src/endpoints/mex/mex.pair.service";
import { MexFarmService } from "src/endpoints/mex/mex.farm.service";
import { CachingService, Constants, Lock, GuestCachingWarmer, OriginLogger } from "@multiversx/sdk-nestjs";
import { DelegationLegacyService } from "src/endpoints/delegation.legacy/delegation.legacy.service";
import { PluginService } from "src/common/plugins/plugin.service";
import { SettingsService } from "src/common/settings/settings.service";
import { TokenService } from "src/endpoints/tokens/token.service";
import { IndexerService } from "src/common/indexer/indexer.service";
import { NftService } from "src/endpoints/nfts/nft.service";
import { TokenType } from "src/common/indexer/entities";

@Injectable()
export class CacheWarmerService {
  private readonly logger = new OriginLogger(CacheWarmerService.name);

  constructor(
    private readonly nodeService: NodeService,
    private readonly esdtService: EsdtService,
    private readonly identitiesService: IdentitiesService,
    private readonly providerService: ProviderService,
    private readonly keybaseService: KeybaseService,
    private readonly pluginsService: PluginService,
    private readonly cachingService: CachingService,
    @Inject('PUBSUB_SERVICE') private clientProxy: ClientProxy,
    private readonly apiConfigService: ApiConfigService,
    private readonly settingsService: SettingsService,
    @Inject(forwardRef(() => NetworkService))
    private readonly networkService: NetworkService,
    private readonly accountService: AccountService,
    private readonly gatewayService: GatewayService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly assetsService: AssetsService,
    private readonly mexPairsService: MexPairService,
    private readonly mexSettingsService: MexSettingsService,
    private readonly mexFarmsService: MexFarmService,
    private readonly delegationLegacyService: DelegationLegacyService,
    private readonly tokenService: TokenService,
    private readonly indexerService: IndexerService,
    private readonly nftService: NftService,
    private readonly guestCachingWarmer: GuestCachingWarmer,
  ) {
    this.configCronJob(
      'handleKeybaseAgainstKeybasePubInvalidations',
      CronExpression.EVERY_MINUTE,
      CronExpression.EVERY_30_MINUTES,
      async () => await this.handleKeybaseAgainstKeybasePubInvalidations()
    );

    this.configCronJob(
      'handleKeybaseAgainstCacheInvalidations',
      CronExpression.EVERY_MINUTE,
      CronExpression.EVERY_10_MINUTES,
      async () => await this.handleKeybaseAgainstCacheInvalidations()
    );

    this.configCronJob(
      'handleIdentityInvalidations',
      CronExpression.EVERY_MINUTE,
      CronExpression.EVERY_5_MINUTES,
      async () => await this.handleIdentityInvalidations()
    );

    if (this.apiConfigService.isStakingV4Enabled()) {
      const handleNodeAuctionInvalidationsCronJob = new CronJob(this.apiConfigService.getStakingV4CronExpression(), async () => await this.handleNodeAuctionInvalidations());
      this.schedulerRegistry.addCronJob(this.handleNodeAuctionInvalidations.name, handleNodeAuctionInvalidationsCronJob);
      handleNodeAuctionInvalidationsCronJob.start();
    }

    if (this.apiConfigService.isUpdateCollectionExtraDetailsEnabled()) {
      const handleUpdateCollectionExtraDetailsCronJob = new CronJob(CronExpression.EVERY_10_MINUTES, async () => await this.handleUpdateCollectionExtraDetails());
      this.schedulerRegistry.addCronJob(this.handleUpdateCollectionExtraDetails.name, handleUpdateCollectionExtraDetailsCronJob);
      handleUpdateCollectionExtraDetailsCronJob.start();
    }
  }

  private configCronJob(name: string, fastExpression: string, normalExpression: string, callback: () => Promise<void>) {
    const cronTime = this.apiConfigService.getIsFastWarmerCronActive() ? fastExpression : normalExpression;
    const cronJob = new CronJob(cronTime, async () => await callback());
    this.schedulerRegistry.addCronJob(name, cronJob);
    cronJob.start();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  @Lock({ name: 'About invalidation', verbose: true })
  async handleAboutInvalidation() {
    const about = await this.networkService.getAboutRaw();
    await this.invalidateKey(CacheInfo.About.key, about, CacheInfo.About.ttl);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  @Lock({ name: 'Node invalidations', verbose: true })
  async handleNodeInvalidations() {
    const nodes = await this.nodeService.getAllNodesRaw();
    await this.invalidateKey(CacheInfo.Nodes.key, nodes, CacheInfo.Nodes.ttl);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  @Lock({ name: 'Delegation legacy invalidations', verbose: true })
  async handleDelegationLegacyInvalidations() {
    const delegation = await this.delegationLegacyService.getDelegationRaw();
    await this.invalidateKey(CacheInfo.DelegationLegacy.key, delegation, CacheInfo.DelegationLegacy.ttl);
  }

  @Lock({ name: 'Node auction invalidations', verbose: true })
  async handleNodeAuctionInvalidations() {
    const nodes = await this.nodeService.getAllNodes();
    const auctions = await this.gatewayService.getValidatorAuctions();

    this.nodeService.processAuctions(nodes, auctions);

    await this.invalidateKey(CacheInfo.Nodes.key, nodes, CacheInfo.Nodes.ttl);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  @Lock({ name: 'All Tokens invalidations', verbose: true })
  async handleEsdtTokenInvalidations() {
    const tokens = await this.tokenService.getAllTokensRaw();
    await this.invalidateKey(CacheInfo.AllEsdtTokens.key, tokens, CacheInfo.AllEsdtTokens.ttl);
  }

  @Lock({ name: 'Identities invalidations', verbose: true })
  async handleIdentityInvalidations() {
    const identities = await this.identitiesService.getAllIdentitiesRaw();
    await this.invalidateKey(CacheInfo.Identities.key, identities, CacheInfo.Identities.ttl);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  @Lock({ name: 'Providers invalidations', verbose: true })
  async handleProviderInvalidations() {
    const providers = await this.providerService.getAllProvidersRaw();
    await this.invalidateKey(CacheInfo.Providers.key, providers, CacheInfo.Providers.ttl);

    const providersWithStakeInformation = await this.providerService.getProvidersWithStakeInformationRaw();
    await this.invalidateKey(CacheInfo.ProvidersWithStakeInformation.key, providersWithStakeInformation, CacheInfo.ProvidersWithStakeInformation.ttl);
  }

  @Lock({ name: 'Keybase against cache invalidations', verbose: true })
  async handleKeybaseAgainstCacheInvalidations() {
    const nodesAndProvidersKeybases = await this.keybaseService.confirmKeybasesAgainstCache();
    const identityProfilesKeybases = await this.keybaseService.getIdentitiesProfilesAgainstCache();
    await Promise.all([
      this.invalidateKey(CacheInfo.Keybases.key, nodesAndProvidersKeybases, CacheInfo.Keybases.ttl),
      this.invalidateKey(CacheInfo.IdentityProfilesKeybases.key, identityProfilesKeybases, CacheInfo.IdentityProfilesKeybases.ttl),
    ]);

    await this.handleNodeInvalidations();
    await this.handleProviderInvalidations();
    await this.handleIdentityInvalidations();
  }

  @Lock({ name: 'Keybase against database / keybase.pub / keybase.io invalidations', verbose: true })
  async handleKeybaseAgainstKeybasePubInvalidations() {
    await this.keybaseService.confirmKeybasesAgainstDatabase();
    await this.keybaseService.confirmKeybasesAgainstGithubOrKeybasePub();
    await this.keybaseService.confirmIdentityProfilesAgainstKeybaseIo();

    await this.handleKeybaseAgainstCacheInvalidations();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  @Lock({ name: 'Current price invalidations', verbose: true })
  async handleCurrentPriceInvalidations() {
    const currentPrice = await this.pluginsService.getEgldPrice();
    if (currentPrice) {
      await this.invalidateKey(CacheInfo.CurrentPrice.key, currentPrice, CacheInfo.CurrentPrice.ttl);
    }
  }

  @Cron("*/6 * * * * *")
  @Lock({ name: 'Guest caching recompute', verbose: true })
  async handleGuestCaching() {
    if (this.apiConfigService.isGuestCachingFeatureActive()) {
      await this.guestCachingWarmer.recompute({
        targetUrl: this.apiConfigService.getSelfUrl(),
        cacheTriggerHitsThreshold: this.apiConfigService.getGuestCachingHitsThreshold(),
        cacheTtl: this.apiConfigService.getGuestCachingTtl(),
      });
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  @Lock({ name: 'Economics invalidations', verbose: true })
  async handleEconomicsInvalidations() {
    const economics = await this.networkService.getEconomicsRaw();
    await this.invalidateKey(CacheInfo.Economics.key, economics, CacheInfo.Economics.ttl);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  @Lock({ name: 'Accounts invalidations', verbose: true })
  async handleAccountInvalidations() {
    const accounts = await this.accountService.getAccountsRaw({ from: 0, size: 25 });
    await this.invalidateKey(CacheInfo.Top25Accounts.key, accounts, CacheInfo.Top25Accounts.ttl);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  @Lock({ name: 'Heartbeatstatus invalidations', verbose: true })
  async handleHeartbeatStatusInvalidations() {
    const result = await this.gatewayService.getRaw('node/heartbeatstatus', GatewayComponentRequest.nodeHeartbeat);
    await this.invalidateKey('heartbeatstatus', JSON.stringify(result.data), Constants.oneMinute() * 2);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  @Lock({ name: 'Validator statistics invalidations', verbose: true })
  async handleValidatorStatisticsInvalidations() {
    const result = await this.gatewayService.getRaw('validator/statistics', GatewayComponentRequest.validatorStatistics);
    await this.invalidateKey('validatorstatistics', JSON.stringify(result.data), Constants.oneMinute() * 2);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  @Lock({ name: 'Token / account assets invalidations', verbose: true })
  async handleTokenAssetsInvalidations() {
    await this.assetsService.checkout();
    const assets = this.assetsService.getAllTokenAssetsRaw();
    await this.invalidateKey(CacheInfo.TokenAssets.key, assets, CacheInfo.TokenAssets.ttl);

    const providers = await this.providerService.getAllProviders();
    const identities = await this.identitiesService.getAllIdentities();

    const pairs = await this.mexPairsService.getAllMexPairs();
    const farms = await this.mexFarmsService.getAllMexFarms();
    const settings = await this.mexSettingsService.getSettings();
    const stakingProxies = await this.mexFarmsService.getAllStakingProxies();

    const accountLabels = await this.assetsService.getAllAccountAssetsRaw(providers, identities, pairs, farms, settings ?? undefined, stakingProxies);
    await this.invalidateKey(CacheInfo.AccountAssets.key, accountLabels, CacheInfo.AccountAssets.ttl);

    const collectionRanks = await this.assetsService.getAllCollectionRanksRaw();
    await this.invalidateKey(CacheInfo.CollectionRanks.key, collectionRanks, CacheInfo.CollectionRanks.ttl);
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  @Lock({ name: 'Token assets extra info invalidations', verbose: true })
  async handleTokenAssetsExtraInfoInvalidations() {
    const assets = await this.assetsService.getAllTokenAssets();
    for (const identifier of Object.keys(assets)) {
      const asset = assets[identifier];

      if (asset.lockedAccounts) {
        const lockedAccounts = await this.esdtService.getLockedAccountsRaw(identifier);
        await this.invalidateKey(CacheInfo.TokenLockedAccounts(identifier).key, lockedAccounts, CacheInfo.TokenLockedAccounts(identifier).ttl);
      }

      if (asset.extraTokens) {
        const accounts = await this.esdtService.countAllAccounts([identifier, ...asset.extraTokens]);
        await this.cachingService.setCacheRemote(
          CacheInfo.TokenAccountsExtra(identifier).key,
          accounts,
          CacheInfo.TokenAccountsExtra(identifier).ttl
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  @Lock({ name: 'Api settings invalidations' })
  async handleApiSettings() {
    const settings = await this.settingsService.getAllSettings();
    await Promise.all(settings.map(async (setting) => {
      await this.invalidateKey(CacheInfo.Setting(setting.name).key, setting.value, CacheInfo.Setting(setting.name).ttl);
    }));
  }

  @Lock({ name: 'Elastic updater: Update collection isVerified, nftCount, holderCount', verbose: true })
  async handleUpdateCollectionExtraDetails() {
    const allAssets = await this.assetsService.getAllTokenAssets();

    for (const key of Object.keys(allAssets)) {
      const collection = await this.indexerService.getCollection(key);
      if (!collection) {
        continue;
      }

      if (![TokenType.NonFungibleESDT, TokenType.SemiFungibleESDT].includes(collection.type as TokenType)) {
        continue;
      }

      const nftCount = await this.nftService.getNftCount({ collection: collection._id });
      const holderCount = await this.esdtService.countAllAccounts([collection._id]);

      this.logger.log(`Setting isVerified to true, holderCount to ${holderCount}, nftCount to ${nftCount} for collection with identifier '${key}'`);
      await this.indexerService.setExtraCollectionFields(key, true, holderCount, nftCount);
    }
  }

  private async invalidateKey(key: string, data: any, ttl: number) {
    await this.cachingService.setCache(key, data, ttl);
    await this.refreshCacheKey(key, ttl);
  }

  private async refreshCacheKey(key: string, ttl: number) {
    await this.clientProxy.emit('refreshCacheKey', { key, ttl });
  }
}
