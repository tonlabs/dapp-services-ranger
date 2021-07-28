import { Config } from "arangojs/connection";
import { 
    Block,
    BmtDb, 
    ChainOrderedTransaction, 
    MasterChainBlock, 
    ShardChainBlock 
} from "./bmt-db";

export class DistributedBmtDb {
    readonly databases: BmtDb[];

    private constructor(databases: BmtDb[]) {
        this.databases = [...databases];
        this.databases.sort(db => db.summary.min_time);

        this.databases.reduce((prev_time, db) => {
            if (prev_time >= db.summary.min_time) {
                throw new Error(`Time range intersection of databases is not supported,` + 
                    `but occured at ${prev_time}. One of databases is ${db.arango_db.name}`);
            }

            return db.summary.max_time;
        }, -1);
    }

    static async create(config: Config[]): Promise<DistributedBmtDb> {
        const databases = await Promise.all(
            config.map(db_config => BmtDb.create(db_config)));

        return new DistributedBmtDb(databases);
    }

    get_max_mc_seq_no(): number {
        return this.databases.reduce<number>((max_mc_seq_no, curr) => {
            return (
                curr.summary.max_mc_seq_no && 
                curr.summary.max_mc_seq_no > max_mc_seq_no)
                ? curr.summary.max_mc_seq_no
                : max_mc_seq_no;
        }, -1)
    }

    async get_masterchain_block_by_seq_no(seq_no: number): Promise<MasterChainBlock> {
        const db = this.databases.find(db => 
            db.summary.min_mc_seq_no && seq_no >= db.summary.min_mc_seq_no && 
            db.summary.max_mc_seq_no && seq_no <= db.summary.max_mc_seq_no);

        if (!db) {
            throw new Error(`Database with mc_seq_no ${seq_no} not found`);
        }

        return db.get_masterchain_block_by_seq_no(seq_no);
    }

    async get_shardchain_blocks_by_ids(ids: string[], max_time: number): Promise<ShardChainBlock[]> {
        const databases = this.databases;
        let db_index = databases.findIndex(db => max_time >= db.summary.min_time && max_time <= db.summary.max_time);
        db_index = (db_index > -1) ? db_index : databases.length - 1;

        const blocks = [] as ShardChainBlock[];
        while (blocks.length < ids.length) {
            if (db_index < 0) {
                throw new Error(`Blocks not found: ${ids.filter(id => !blocks.find(b => b.id == id)).join(", ")}`)
            }

            const current_blocks = await databases[db_index].find_shardchain_blocks_by_ids(ids);
            blocks.push(...current_blocks);
            db_index--;
        }
        
        return blocks;
    }

    async set_transaction_chain_orders(chain_orders: ChainOrderedTransaction[], time: number): Promise<void> {
        const db = this.get_db_by_time(time);
        await db.set_transaction_chain_orders(chain_orders);
    }

    async set_chain_order_for_block(block: Block, chain_order: string): Promise<void> {
        const db = this.get_db_by_time(block.gen_utime);
        await db.set_chain_order_for_block(block, chain_order);
    }

    async verify_block_and_transactions(block: Block): Promise<void> {
        const db = this.get_db_by_time(block.gen_utime);
        await db.verify_block_and_transactions(block);
    }

    get_db_by_time(time: number): BmtDb {
        const db = this.databases.find(db => time >= db.summary.min_time && time <= db.summary.max_time);

        if (!db) {
            throw new Error(`Database with time ${time} not found`);
        }

        return db;
    }

    async refresh_databases(): Promise<void> {
        await Promise.all(
            this.databases.map(db => db.update_summary())
        );

        this.databases.sort(db => db.summary.min_time);

        this.databases.reduce((prev_time, db) => {
            if (prev_time >= db.summary.min_time) {
                throw new Error(`Time range intersection of databases is not supported,` + 
                    `but occured at ${prev_time}. One of databases is ${db.arango_db.name}`);
            }

            return db.summary.max_time;
        }, -1);
    }
}
