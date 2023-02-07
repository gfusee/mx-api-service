import { OriginLogger } from "@multiversx/sdk-nestjs";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { TransactionDb } from "./entities/transaction.db.entity";

@Injectable()
export class TransactionDbService {
    private readonly logger = new OriginLogger(TransactionDbService.name);

    constructor(
        @InjectRepository(TransactionDb)
        private transactionDbRepository: Repository<TransactionDb>,
    ) { }

    // eslint-disable-next-line require-await
    async createTransaction(transaction: TransactionDb) {
        this.logger.log(`Creating new transaction: ${transaction.tx_hash}`);

        await this.transactionDbRepository.save(transaction);
    }

    async findTransaction(txId: string): Promise<TransactionDb | null> {
        return await this.transactionDbRepository.findOne({ where: { tx_hash: txId } });
    }

    async findAllTransactions(): Promise<TransactionDb[]> {
        return await this.transactionDbRepository.find();
    }
}
