import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { GatewayService } from "src/common/gateway/gateway.service";
import { SmartContractResult } from "../sc-results/entities/smart.contract.result";
import { Transaction } from "./entities/transaction";
import { TransactionDetailed } from "./entities/transaction.detailed";
import { TransactionLog } from "./entities/transaction.log";
import { TransactionOptionalFieldOption } from "./entities/transaction.optional.field.options";
import { TransactionReceipt } from "./entities/transaction.receipt";
import { TokenTransferService } from "../tokens/token.transfer.service";
import { ApiUtils, BinaryUtils } from "@multiversx/sdk-nestjs";
import { TransactionUtils } from "./transaction.utils";
import { IndexerService } from "src/common/indexer/indexer.service";
import { OriginLogger } from "@multiversx/sdk-nestjs";

@Injectable()
export class TransactionGetService {
  private readonly logger = new OriginLogger(TransactionGetService.name);

  constructor(
    private readonly indexerService: IndexerService,
    private readonly gatewayService: GatewayService,
    @Inject(forwardRef(() => TokenTransferService))
    private readonly tokenTransferService: TokenTransferService,
  ) { }

  private async tryGetTransactionFromElasticBySenderAndNonce(sender: string, nonce: number): Promise<TransactionDetailed | undefined> {
    const transactions = await this.indexerService.getTransactionBySenderAndNonce(sender, nonce);
    return transactions.firstOrUndefined() as TransactionDetailed | undefined;
  }

  async getTransactionLogsFromElastic(hashes: string[]): Promise<TransactionLog[]> {
    let currentHashes = hashes.slice(0, 1000);
    const result = [];
    while (currentHashes.length > 0) {
      const items = await this.getTransactionLogsFromElasticInternal(currentHashes);
      result.push(...items);

      hashes = hashes.slice(1000);
      currentHashes = hashes.slice(0, 1000);
    }

    return result.map(x => ApiUtils.mergeObjects(new TransactionLog(), x));
  }

  private async getTransactionLogsFromElasticInternal(hashes: string[]): Promise<any[]> {
    return await this.indexerService.getTransactionLogs(hashes);
  }

  async getTransactionScResultsFromElastic(txHash: string): Promise<SmartContractResult[]> {
    const scResults = await this.indexerService.getTransactionScResults(txHash);
    return scResults.map(scResult => ApiUtils.mergeObjects(new SmartContractResult(), scResult));
  }

  async tryGetTransactionFromElastic(txHash: string, fields?: string[]): Promise<TransactionDetailed | null> {
    let transaction: any;
    try {
      transaction = await this.indexerService.getTransaction(txHash);
      if (!transaction) {
        return null;
      }
    } catch (error: any) {
      this.logger.error(`Unexpected error when getting transaction from elastic, hash '${txHash}'`);
      this.logger.error(error);

      throw error;
    }

    try {
      if (transaction.scResults) {
        transaction.results = transaction.scResults;
      }

      const transactionDetailed: TransactionDetailed = ApiUtils.mergeObjects(new TransactionDetailed(), transaction);

      const hashes: string[] = [];
      hashes.push(txHash);
      const previousHashes: Record<string, string> = {};

      if (transaction.hasScResults === true && (!fields || fields.length === 0 || fields.includes(TransactionOptionalFieldOption.results))) {
        transactionDetailed.results = await this.getTransactionScResultsFromElastic(transactionDetailed.txHash);

        for (const scResult of transactionDetailed.results) {
          hashes.push(scResult.hash);
          previousHashes[scResult.hash] = scResult.prevTxHash;
        }
      }

      if (!fields || fields.length === 0 || fields.includes(TransactionOptionalFieldOption.receipt)) {
        const receipts = await this.indexerService.getTransactionReceipts(txHash);
        if (receipts.length > 0) {
          const receipt = receipts[0];
          transactionDetailed.receipt = ApiUtils.mergeObjects(new TransactionReceipt(), receipt);
        }
      }

      if (!fields || fields.length === 0 || fields.includes(TransactionOptionalFieldOption.logs) || fields.includes(TransactionOptionalFieldOption.operations)) {
        const logs = await this.getTransactionLogsFromElastic(hashes);

        if (!fields || fields.length === 0 || fields.includes(TransactionOptionalFieldOption.operations)) {
          transactionDetailed.operations = await this.tokenTransferService.getOperationsForTransaction(transactionDetailed, logs);
          transactionDetailed.operations = TransactionUtils.trimOperations(transactionDetailed.sender, transactionDetailed.operations, previousHashes);
        }

        for (const log of logs) {
          if (log.id === txHash) {
            transactionDetailed.logs = log;
          } else if (transactionDetailed.results) {
            const foundScResult = transactionDetailed.results.find(({ hash }) => log.id === hash);
            if (foundScResult) {
              foundScResult.logs = log;
            }
          }
        }
      }

      return ApiUtils.mergeObjects(new TransactionDetailed(), transactionDetailed);
    } catch (error) {
      this.logger.error(error);
      return null;
    }
  }

  async tryGetTransactionFromGatewayForList(txHash: string) {
    const gatewayTransaction = await this.tryGetTransactionFromGateway(txHash, false);
    if (gatewayTransaction) {
      return ApiUtils.mergeObjects(new Transaction(), gatewayTransaction);
    }
    return undefined; //invalid hash 
  }

  async tryGetTransactionFromGateway(txHash: string, queryInElastic: boolean = true): Promise<TransactionDetailed | null> {
    try {
      // eslint-disable-next-line require-await
      const transactionResult = await this.gatewayService.getTransaction(txHash);

      if (!transactionResult) {
        return null;
      }

      const transaction = transactionResult;

      if (!transaction) {
        return null;
      }

      if (transaction.miniblockType === 'SmartContractResultBlock') {
        return null;
      }

      if (transaction.status === 'pending' && queryInElastic) {
        const existingTransaction = await this.tryGetTransactionFromElasticBySenderAndNonce(transaction.sender, transaction.nonce);
        if (existingTransaction && existingTransaction.txHash !== txHash) {
          return null;
        }
      }

      if (transaction.receipt) {
        transaction.receipt.value = transaction.receipt.value.toString();
      }

      if (transaction.smartContractResults) {
        for (const smartContractResult of transaction.smartContractResults) {
          smartContractResult.callType = smartContractResult.callType.toString();
          smartContractResult.value = smartContractResult.value.toString();

          if (smartContractResult.data) {
            smartContractResult.data = BinaryUtils.base64Encode(smartContractResult.data);
          }
        }
      }

      const result = {
        txHash: txHash,
        data: transaction.data,
        gasLimit: transaction.gasLimit,
        gasPrice: transaction.gasPrice,
        gasUsed: transaction.gasUsed,
        miniBlockHash: transaction.miniblockHash,
        senderShard: transaction.sourceShard,
        receiverShard: transaction.destinationShard,
        nonce: transaction.nonce,
        receiver: transaction.receiver,
        sender: transaction.sender,
        signature: transaction.signature,
        status: transaction.status,
        value: transaction.value,
        round: transaction.round,
        fee: transaction.fee,
        timestamp: transaction.timestamp,
        scResults: transaction.smartContractResults ? transaction.smartContractResults.map((scResult: any) => ApiUtils.mergeObjects(new SmartContractResult(), scResult)) : [],
        receipt: transaction.receipt ? ApiUtils.mergeObjects(new TransactionReceipt(), transaction.receipt) : undefined,
        logs: transaction.logs,
      };

      return ApiUtils.mergeObjects(new TransactionDetailed(), result);
    } catch (error) {
      this.logger.error(error);
      return null;
    }
  }
}
